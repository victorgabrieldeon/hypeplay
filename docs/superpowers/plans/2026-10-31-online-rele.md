# Online pelo servidor (relé) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando o P2P (WebRTC) entre host e jogador 2 não conecta, ou um dos dois não tem WebRTC (Discord), a imagem, o som e o controle passam por um WebSocket do próprio app.

**Architecture:** O servidor ganha um relé burro (`server/relay.ts`) que repassa pacotes binários entre o host e o convidado de uma sala, ligado como um terceiro `kind` do `NetData`. Os pacotes ficam num módulo compartilhado (`page/relaywire.ts`). O host codifica com WebCodecs (`page/relayhost.ts`), o convidado decodifica (`page/relayguest.ts`), e o som passa por AudioWorklets (`page/relayaudio.ts`). A troca P2P → relé é combinada pelas caixas de entrada das salas de hoje (mensagens `relay`, `relay-only`, `relay-no`).

**Tech Stack:** Bun 1.4 (`Bun.serve` WebSocket, `getBufferedAmount()`), TypeScript, `bun:test`, WebCodecs (`VideoEncoder`/`VideoDecoder`/`AudioEncoder`/`AudioDecoder`), AudioWorklet, `requestVideoFrameCallback`.

**Spec:** [`docs/superpowers/specs/2026-10-31-online-rele-design.md`](../specs/2026-10-31-online-rele-design.md)

## Global Constraints

- O P2P continua sendo tentado primeiro; com ele funcionando, nada muda (o relé não entra).
- Troca para o relé: na hora, sem WebRTC num dos lados; senão, 6 s (`LINK_MS = 6000`) depois de a oferta chegar sem conectar, ou `failed` antes disso.
- Vídeo: 640×480, 60 fps, 2,5 Mbps (`bitrate: 2_500_000`), `latencyMode: "realtime"`, quadro-chave a cada 120 quadros (2 s) e a cada `KEY`. Codecs, nesta ordem: `avc1.42E01F` (com `avc: { format: "annexb" }`, sem `description`), depois `vp8`.
- Som: Opus, 48 kHz, 2 canais, 96 kbps (`bitrate: 96_000`). Buffer do convidado: alvo 60 ms, descarte acima de 200 ms.
- Controle: o JSON de `encodePad` (`page/guestpad.ts`), mandado quando muda e a cada 100 ms parado.
- Servidor: pacote acima de 1 MB (`MAX_PACKET = 1 << 20`) é descartado; convidado com mais de 1 MB pendente (`SLOW_BYTES = 1 << 20`) perde `VIDEO` e `AUDIO` até o próximo `VIDEO` quadro-chave, e o host recebe um `KEY`.
- Tipos de pacote (primeiro byte): `HELLO` 1, `CONFIG` 2, `VIDEO` 3, `AUDIO` 4, `PAD` 5, `KEY` 6, `BYE` 7. Do host só passam 2, 3, 4, 7; do convidado só 1, 5, 6, 7.
- Endereço: `p/<pass>/ps2/<id>/room/<code>/relay?role=host` e `…?role=guest&me=<id>`. Host só o dono da sala; convidado só quem fez `join`; um convidado com outro `me` é recusado, o mesmo `me` substitui a conexão anterior; um segundo host substitui o anterior.
- Textos da interface em português do Brasil; comentários de código em inglês curto, como os de hoje.
- Antes de cada commit: `bun test` e `bun run typecheck` verdes. Commits com o helper `gc` (que acrescenta `Co-Authored-By`).

## Review Focus

1. **O convidado conecta ao relé antes do host** (o host ainda abrindo o WebSocket): o `HELLO` dele não pode se perder; o servidor guarda o último `HELLO` e o entrega quando o host conecta. → teste em Task 2.
2. **O host recarrega a página no meio do jogo** (um segundo host substitui o primeiro): o convidado recebe um `CONFIG` novo e tem de reconfigurar o decodificador e esperar o quadro-chave, em vez de travar. → teste em Task 2 (o servidor manda o `HELLO` guardado ao host novo) e conferência em Task 7.
3. **Nenhum codec em comum** (o convidado não decodifica nem H.264 nem VP8): o host responde `relay-no` e o convidado vê o motivo, em vez de ficar em "Conectando pelo servidor…". → teste em Task 1 (`pickCodec` devolve `null`) e Task 4 (a mensagem).
4. **O convidado pede o relé enquanto o host ainda tem a conexão P2P dele aberta**: o host fecha a conexão WebRTC daquele convidado antes de abrir o relé, para não mandar o controle dobrado. → conferência em Task 7.
5. **Pacote binário quebrado ou de outro sentido** (convidado mandando `VIDEO`, pacote vazio): o servidor descarta sem derrubar ninguém. → teste em Task 2.

---

### Task 1: Os pacotes do relé

**Files:**
- Create: `page/relaywire.ts`
- Test: `page/relaywire.test.ts`

**Interfaces:**
- Produces:
  - constantes `HELLO = 1`, `CONFIG = 2`, `VIDEO = 3`, `AUDIO = 4`, `PAD = 5`, `KEY = 6`, `BYE = 7`; `FROM_HOST: ReadonlySet<number>` = {2, 3, 4, 7}; `FROM_GUEST: ReadonlySet<number>` = {1, 5, 6, 7};
  - `VIDEO_CODECS = ["avc1.42E01F", "vp8"] as const`;
  - `type VideoConfig = { codec: string; width: number; height: number }`; `type AudioConfig = { codec: "opus"; sampleRate: 48000; numberOfChannels: 2 }`;
  - `type Packet = { t: "hello"; video: string[]; audio: string[] } | { t: "config"; video: VideoConfig; audio: AudioConfig | null } | { t: "video"; key: boolean; time: number; data: Uint8Array } | { t: "audio"; time: number; data: Uint8Array } | { t: "pad"; pad: unknown } | { t: "key" } | { t: "bye" }`;
  - `encode(p: Packet): Uint8Array<ArrayBuffer>`; `decode(b: Uint8Array): Packet | null`;
  - `isKeyVideo(b: Uint8Array): boolean` (para o servidor, sem decodificar o resto);
  - `pickCodec(guest: readonly string[], hostCan: (codec: string) => Promise<boolean>): Promise<string | null>`: o primeiro de `VIDEO_CODECS` que o convidado tem e o host aceita.

- [ ] **Step 1: Escrever os testes**

```ts
test("each packet goes and comes back as it was", () => {
  const data = Uint8Array.of(9, 8, 7);
  for (const p of [
    { t: "hello", video: ["vp8"], audio: ["opus"] },
    { t: "config", video: { codec: "vp8", width: 640, height: 480 }, audio: { codec: "opus", sampleRate: 48000, numberOfChannels: 2 } },
    { t: "video", key: true, time: 4_294_967_295, data },
    { t: "audio", time: 20, data },
    { t: "pad", pad: { b: [1, 0], a: [0.5] } },
    { t: "key" },
    { t: "bye" },
  ] as Packet[]) expect(decode(encode(p))).toEqual(p);
});
test("the first byte is the kind, the video's key flag the second's low bit", () => {
  expect(encode({ t: "video", key: true, time: 1, data: new Uint8Array() })[0]).toBe(VIDEO);
  expect(isKeyVideo(encode({ t: "video", key: true, time: 1, data: new Uint8Array() }))).toBe(true);
  expect(isKeyVideo(encode({ t: "video", key: false, time: 1, data: new Uint8Array() }))).toBe(false);
  expect(isKeyVideo(encode({ t: "key" }))).toBe(false);
});
test("what isn't a packet is null", () => {
  for (const b of [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(99), Uint8Array.of(VIDEO, 1), Uint8Array.of(HELLO, 123)]) expect(decode(b)).toBeNull();
});
test("the codec: the first both can, H.264 before VP8, none in common is null", async () => {
  expect(await pickCodec(["vp8", "avc1.42E01F"], async () => true)).toBe("avc1.42E01F");
  expect(await pickCodec(["vp8", "avc1.42E01F"], async (c) => c === "vp8")).toBe("vp8");
  expect(await pickCodec(["av01.0.04M.08"], async () => true)).toBeNull();
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test page/relaywire.test.ts`
Expected: FAIL (o módulo não existe)

- [ ] **Step 3: Implementar `page/relaywire.ts`**

Layout de cada tipo, como na spec: `HELLO`/`CONFIG`/`PAD` = tipo + JSON em UTF-8; `VIDEO` = tipo, flags (bit 0 = quadro-chave), tempo u32 big-endian, dados; `AUDIO` = tipo, tempo u32 big-endian, dados; `KEY`/`BYE` = só o tipo. `decode` devolve `null` para tipo desconhecido, cabeçalho curto ou JSON inválido.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test page/relaywire.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add page/relaywire.ts page/relaywire.test.ts
gc "Relé do online: os pacotes"
```

### Task 2: O relé no servidor

**Files:**
- Create: `server/relay.ts`
- Modify: `server/ps2rooms.ts` (dois métodos de leitura)
- Test: `server/relay.test.ts`, `server/ps2rooms.test.ts`

**Interfaces:**
- Consumes: `FROM_HOST`, `FROM_GUEST`, `isKeyVideo`, `encode`, `KEY`, `BYE`, `HELLO` (Task 1).
- Produces:
  - em `Ps2Rooms`: `hostOf(code: string): string | null` (o `hostId` da sala, `null` sem sala); `hasGuest(code: string, me: string): boolean` (fez `join` e não `bye`);
  - em `server/relay.ts`: `interface RelaySocket { send(data: Uint8Array): number; close(code?: number, reason?: string): void; getBufferedAmount(): number }`; `MAX_PACKET = 1 << 20`; `SLOW_BYTES = 1 << 20`; `class Relay { open(ws: RelaySocket, room: string, role: "host" | "guest", me: string): void; message(ws: RelaySocket, data: string | Uint8Array): void; close(ws: RelaySocket): void }`.

- [ ] **Step 1: Escrever os testes**

Em `server/ps2rooms.test.ts`: `hostOf` devolve o id do dono e `null` para sala inexistente; `hasGuest` é `true` depois de `join`, `false` depois de `bye` e para quem nunca entrou.

Em `server/relay.test.ts`, com um `RelaySocket` falso (guarda o que recebeu, se foi fechado, e um `buffered` ajustável):
- `"host to guest: config, video, audio and bye; guest to host: hello, pad, key and bye"`: cada tipo chega ao outro lado; um `VIDEO` vindo do convidado e um `PAD` vindo do host não chegam a ninguém;
- `"what isn't a packet, or is over 1 MB, is dropped and nobody falls"`: `Uint8Array.of()`, `Uint8Array.of(99)`, uma string e um pacote de `MAX_PACKET + 1` bytes não chegam e nenhum socket é fechado;
- `"a guest that came first: its hello reaches the host when it opens"` e `"a host that comes again gets the guest's hello again"` (Review Focus 1 e 2);
- `"one player 2: another guest is refused, the same one again takes its place"`: um segundo `me` é fechado (código 4001, motivo `"full"`), o mesmo `me` substitui o anterior (o antigo é fechado);
- `"a slow guest loses video and audio until a key frame, and the host is asked for one"`: com `buffered > SLOW_BYTES`, um `VIDEO` não-chave e um `AUDIO` não chegam e o host recebe um `KEY`; com `buffered` baixo de novo, um `VIDEO` não-chave ainda é descartado e o próximo `VIDEO` chave chega, e depois os não-chave voltam a chegar;
- `"either leaving: the other hears bye"`: `close(host)` manda `BYE` ao convidado e o fecha; `close(guest)` manda `BYE` ao host.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test server/relay.test.ts server/ps2rooms.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar**

`Relay` guarda por sala `{ host?: RelaySocket; guest?: { ws: RelaySocket; me: string }; hello?: Uint8Array; skipping: boolean }` e um `Map<RelaySocket, { room; role }>`. Sem gravar nada fora da memória; sala sem nenhum dos dois é apagada do mapa.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test server/relay.test.ts server/ps2rooms.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/relay.ts server/relay.test.ts server/ps2rooms.ts server/ps2rooms.test.ts
gc "Relé do online: o repasse no servidor"
```

### Task 3: A rota do relé

**Files:**
- Modify: `server/routes.ts` (`NetData`, `ps2Room`, `websocket`)
- Test: `server/routes.ps2.test.ts`

**Interfaces:**
- Consumes: `Relay`, `Ps2Rooms.hostOf`, `Ps2Rooms.hasGuest` (Task 2).
- Produces: `NetData` com `| { kind: "relay"; room: string; role: "host" | "guest"; me: string }`; a rota `ps2/<id>/room/<code>/relay`, checada **antes** da caixa de entrada (`relay` também casa com `INBOX`).

- [ ] **Step 1: Escrever o teste**

`"the relay: only the room's host and a guest that joined; the rest is refused before the upgrade"`: com uma sala aberta pela Ana e um `join` da Bia como `bia1` (pela caixa de entrada):
- `GET …/room/<code>/relay?role=host` da Ana → 426 (autorizado; sem `server` no teste, não há upgrade);
- o mesmo da Bia → 403;
- `?role=guest&me=bia1` da Bia → 426; `?role=guest&me=outro` → 403; `?role=xx` → 400;
- sala inexistente → 404.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test server/routes.ps2.test.ts -t "the relay"`
Expected: FAIL

- [ ] **Step 3: Implementar**

Em `ps2Room`, antes do regex da caixa de entrada: `/^room\/([A-Z2-9]{6})\/relay$/`. Valida o papel e o acesso pelas `Ps2Rooms`, e depois segue a mesma checagem de `upgrade` do `net/ws`, com `data: { game: id, kind: "relay", room, role, me }`. No `websocket`, `kind === "relay"` vai para um `Relay` criado em `createApp`; os outros `kind` seguem como hoje.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test server/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.ps2.test.ts
gc "Relé do online: a rota, só para o host e o jogador 2 da sala"
```

### Task 4: Quando trocar para o relé, e o que dizer

**Files:**
- Modify: `page/watchsteps.ts`
- Test: `page/watchsteps.test.ts`

**Interfaces:**
- Produces:
  - `LINK_MS = 6000`;
  - `relayWhen(s: { webrtc: boolean; offerAt: number | null; now: number; state: string | null }): "now" | "wait" | "stay"`;
  - `relayStuck(why: "closed" | "no-decoder" | "host-cant"): { title: string; text: string }`.

- [ ] **Step 1: Escrever os testes**

```ts
test("when to go by the server: no WebRTC at once, 6 s after the offer without a link, failed, never once linked", () => {
  expect(relayWhen({ webrtc: false, offerAt: null, now: 0, state: null })).toBe("now");
  expect(relayWhen({ webrtc: true, offerAt: null, now: 50_000, state: null })).toBe("wait");
  expect(relayWhen({ webrtc: true, offerAt: 1000, now: 6999, state: "connecting" })).toBe("wait");
  expect(relayWhen({ webrtc: true, offerAt: 1000, now: 7000, state: "connecting" })).toBe("now");
  expect(relayWhen({ webrtc: true, offerAt: 1000, now: 1500, state: "failed" })).toBe("now");
  expect(relayWhen({ webrtc: true, offerAt: 1000, now: 60_000, state: "connected" })).toBe("stay");
});
test("what player 2 hears when the server's way stops", () => {
  expect(relayStuck("closed").title).toBe("A conexão com o servidor caiu");
  expect(relayStuck("no-decoder").text).toContain("Chrome ou Edge");
  expect(relayStuck("host-cant").text).toContain("O navegador do host não consegue transmitir pelo servidor");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test page/watchsteps.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar** (as frases da spec: "A conexão com o servidor caiu"; "Este navegador não consegue mostrar o jogo pelo servidor. Use um Chrome ou Edge atualizado."; "O navegador do host não consegue transmitir pelo servidor").

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test page/watchsteps.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add page/watchsteps.ts page/watchsteps.test.ts
gc "Relé do online: quando trocar e o que dizer"
```

### Task 5: O host transmite pelo relé

**Files:**
- Create: `page/relayaudio.ts`, `page/relayhost.ts`
- Modify: `page/stream.ts`

**Interfaces:**
- Consumes: `encode`, `decode`, `pickCodec`, `VideoConfig`, `AudioConfig` (Task 1).
- Produces:
  - `relayaudio.ts`: `captureAudio(stream: MediaStream, onPcm: (pcm: Float32Array, frames: number) => void): Promise<() => void>` (48 kHz, estéreo intercalado, blocos de 960 quadros, ou seja, 20 ms); `playAudio(): Promise<{ push(pcm: Float32Array, frames: number): void; resume(): Promise<void>; close(): void }>` (a usar na Task 6). Os dois módulos de AudioWorklet ficam como strings, carregados por `Blob` URL;
  - `relayhost.ts`: `canRelay(): boolean` (`typeof VideoEncoder === "function"`); `startRelay(o: { url: string; canvas: HTMLCanvasElement; audio: MediaStream | null; onPad(pad: unknown): void; onJoin(): void; onLeave(): void; onNoCodec(): void }): { stop(): void }`.

- [ ] **Step 1: Implementar `page/relayaudio.ts`** (só o `captureAudio`; o `playAudio` vem na Task 6).
- [ ] **Step 2: Implementar `page/relayhost.ts`**
  - **Imagem:** `canvas.captureStream(60)` num `<video>` escondido (`muted`, `playsInline`). A cada `requestVideoFrameCallback`, `drawImage` num `OffscreenCanvas(640, 480)` e `new VideoFrame(offscreen, { timestamp })`. O quadro é descartado se `encoder.encodeQueueSize > 2`.
  - **Codec:** no `HELLO`, `pickCodec(hello.video, (c) => VideoEncoder.isConfigSupported(cfg(c)).then((r) => !!r.supported))`; com `null`, chama `onNoCodec()` e para.
  - **Envio:** `CONFIG` e depois os quadros; quadro-chave a cada 120 quadros e no `KEY`.
  - **Som:** `captureAudio` → `AudioData` (`f32`, 48000, 2 canais) → `AudioEncoder` opus 96 kbps. Sem `AudioEncoder` ou sem `audio`, o `CONFIG` vai com `audio: null`.
  - **Controle e saída:** `PAD` → `onPad`; o primeiro `HELLO` → `onJoin`; `BYE` ou a queda → `onLeave`.
- [ ] **Step 3: Ligar em `page/stream.ts`**
  - **`relay` de um convidado:** fecha o `RTCPeerConnection` dele, se houver, e chama `startRelay`. O botão vai a `` `Sala ${code} · jogador 2 conectado pelo servidor` `` no `onJoin`.
  - **`join` com o host sem `RTCPeerConnection`:** manda `{ type: "relay-only" }` ao convidado e já abre o relé.
  - **Sem `canRelay()`, ou com `onNoCodec`:** manda `{ type: "relay-no" }`.
  - **URL:** `new URL(`../room/${code}/relay?role=host`, location.href)` com `ws:`/`wss:`.
- [ ] **Step 4: `bun run typecheck` e `bun test`** — Expected: verdes (a conferência no navegador é a Task 7).
- [ ] **Step 5: Commit**

```bash
git add page/relayaudio.ts page/relayhost.ts page/stream.ts
gc "Relé do online: o host transmite pelo servidor"
```

### Task 6: O convidado recebe pelo relé

**Files:**
- Create: `page/relayguest.ts`
- Modify: `page/relayaudio.ts` (`playAudio`), `page/watch.ts`, `page/watch.html`, `page/home/intro.js`

**Interfaces:**
- Consumes: `encode`, `decode`, `VIDEO_CODECS` (Task 1); `relayWhen`, `relayStuck`, `LINK_MS` (Task 4); `playAudio` (Task 5); `encodePad` (`page/guestpad.ts`).
- Produces: `joinRelay(o: { url: string; canvas: HTMLCanvasElement; pad(): unknown; onLinked(): void; onStuck(why: "closed" | "no-decoder"): void; onSound(): void }): { stop(): void; unmute(): Promise<void> }`.

- [ ] **Step 1: Implementar `playAudio`** em `page/relayaudio.ts` (worklet com fila: alvo 60 ms, descarta acima de 200 ms).
- [ ] **Step 2: Implementar `page/relayguest.ts`**
  - **`HELLO`:** com os codecs de `VIDEO_CODECS` que `VideoDecoder.isConfigSupported` aceita; sem nenhum, `onStuck("no-decoder")`, e `"opus"` se `AudioDecoder.isConfigSupported` aceitar.
  - **`CONFIG`:** (re)configura o decodificador com `optimizeForLatency: true` e espera um quadro-chave (Review Focus 2).
  - **Quadros:** `VIDEO` → `VideoDecoder` → `drawImage` no canvas → `frame.close()`. Erro do decodificador → `KEY` e espera o próximo quadro-chave. O primeiro quadro desenhado chama `onLinked`.
  - **Som e controle:** `AUDIO` → `AudioDecoder` → `playAudio().push`; o primeiro chama `onSound`. `PAD` a cada mudança e a cada 100 ms.
  - **Queda:** `BYE` ou a queda do WebSocket → `onStuck("closed")`.
- [ ] **Step 3: Ligar em `page/watch.ts` e `page/watch.html`**
  - **Canvas:** `<canvas id="relay" hidden>` com o mesmo encaixe do `<video>`.
  - **Quando trocar:** a cada 500 ms, `relayWhen({ webrtc, offerAt, now, state: pc.connectionState })`. Com `"now"`, manda `{ type: "relay", from: me }` ao host, fecha o `pc` e chama `joinRelay`. Ao receber `relay-only`, chama `joinRelay` direto. `?relay=1` força o relé (teste local).
  - **Status:** "Conectando pelo servidor…" enquanto conecta; `relay-no` → `relayStuck("host-cant")`.
  - **Som:** o botão "Ligar o som" chama `unmute()`.
- [ ] **Step 4: Em `page/home/intro.js`**, tirar a condição que desliga "Aqui no Discord" para o convidado sem `RTCPeerConnection` (`guest`): o relé o atende dentro do Discord.
- [ ] **Step 5: `bun run typecheck` e `bun test`** — Expected: verdes.
- [ ] **Step 6: Commit**

```bash
git add page/relayguest.ts page/relayaudio.ts page/watch.ts page/watch.html page/home/intro.js
gc "Relé do online: o convidado recebe pelo servidor, também dentro do Discord"
```

### Task 7: Conferir no navegador e documentar

**Files:**
- Modify: `README.md` (seção Online), `server/index.ts` se a Task 3 pedir (o `Relay` é criado em `createApp`, então não deve)

- [ ] **Step 1: Host e convidado em duas abas locais** (servidor de teste `cordplay-home`). O host é o BT3 (PCSX2) com "Abrir sala"; o convidado é `ps2/slus-21678/watch/?room=<code>&relay=1`. Conferir:
  - a imagem aparece no canvas do convidado em até cerca de 2 s;
  - "Ligar o som" toca o som;
  - uma tecla no convidado (`KEYS` de `guestpad.ts`) chega ao host (`cordplayGuest.set` chamado);
  - a barra do host diz "jogador 2 conectado pelo servidor".
- [ ] **Step 2: Medir o atraso.** O tempo do `VIDEO` (do host) contra `performance.now()` quando o quadro é desenhado no convidado, no mesmo relógio. Expected: abaixo de 150 ms.
- [ ] **Step 3: Review Focus 2 e 4.**
  - Recarregar a aba do host: o convidado volta a mostrar a imagem.
  - Abrir sem `?relay=1`, esperar o P2P conectar e mandar `relay` à mão: o host fecha o P2P e segue pelo relé, com o controle chegando uma vez só.
- [ ] **Step 4: README**, na seção Online: o relé pelo servidor quando o P2P não conecta (e dentro do Discord), e que o TURN continua opcional, para mais conexões diretas.
- [ ] **Step 5: `bun test` e `bun run typecheck`**, commit e push; PR com o que foi medido.

```bash
git add README.md
gc "Relé do online: README"
```
