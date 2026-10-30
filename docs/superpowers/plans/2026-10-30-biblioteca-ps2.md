# Biblioteca de PS2 — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualquer ISO de PS2 enviada pela atividade vira um jogo da biblioteca do CordPlay (compilado uma vez pelo ps2-web-recomp, com capa, saves por pessoa, controle mapeável, intro e online de 2 jogadores), numa home refeita.

**Architecture:** O `app` (Bun, `server/`) ganha módulos pequenos (ISO9660, biblioteca, saves, mapas de controle, capa, salas, ICE) ligados em `routes.ts`; um serviço novo `ps2-builder/` (Bun, no molde de `builder/`) compila um jogo por vez com o `scripts/port.sh` do ps2-web-recomp e aplica um patch fail-loud no `web/shell.html`. A home (`page/index.html`) é refeita sobre o `DESIGN.md`; scripts da página que precisam de lógica testável (`page/pad.ts`, `server/iso9660.ts`) são empacotados pelo servidor ao subir, como o `entry.ts` já é.

**Tech Stack:** Bun 1.4, TypeScript 7 (`tsc --noEmit`), `bun:test`, `sharp`, `@fontsource-variable/inter`, `@fontsource-variable/space-grotesk`, ps2-web-recomp `e026b971324068773eed88bf502437de9e581b6b` (emsdk 6.0.11, clang, cmake, ninja), Pillow.

**Spec:** [`docs/superpowers/specs/2026-10-30-biblioteca-ps2-design.md`](../specs/2026-10-30-biblioteca-ps2-design.md) e [`DESIGN.md`](../../../DESIGN.md).

## Global Constraints

- Nada do jogo no git nem em imagem: ISO, C++ gerado, wasm, capturas e `intro.mp4` só no volume `/app/data/`.
- Tudo sob `/p/<passe>/` exige passe válido (403 sem ele, mensagem de hoje). Ids de jogo nunca viram caminho sem passar pela biblioteca (regex `^[a-z]{4}-\d{5}$`).
- O BT3 não muda de comportamento (rotas, builder, online), exceto a injeção do `pad.js` ao servir o `index.html` dele.
- Textos da interface em português do Brasil, no tom do repo; comentários de código em inglês curto, como os de hoje.
- Cor, tipo, espaço, raio, sombra e movimento só pelos tokens do `DESIGN.md` (CSS variables), nunca valores soltos; `prefers-reduced-motion` desliga translação, brilho e listras.
- Limites fixos: ISO de PS2 100 MiB–9 GiB; capa ≤ 5 MB (PNG/JPG/WebP) → WebP 600×900; memory card 8.650.752 bytes com cabeçalho `Sony PS2 Memory Card Format `; mensagem de sala ≤ 64 KB; long-poll 20 s; sala ociosa 1 h; reserva abandonada 24 h; builder sem sinal > 2 min = `offline`; passe e TURN 12 h.
- `PUBLIC_URL`, `TURN_URL`, `TURN_SECRET` são opcionais; `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET` continuam obrigatórias.
- Antes de cada commit: `bun test` e `bun run typecheck` verdes. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Range malformado ou fora do arquivo no `disc.iso`** (`bytes=5000000000-`, `bytes=abc`, `bytes=10-5`): espera-se 416 com `Content-Range: bytes */<size>`, nunca 500 ou o arquivo inteiro. → teste em Task 7.
2. **Dois uploads concorrentes reservando o mesmo serial** (duas pessoas escolhem o mesmo jogo ao mesmo tempo): o segundo `POST ps2` recebe 409 `{ exists }`, sem duas pastas. → teste em Task 2.
3. **Jogo removido enquanto alguém joga ou compila**: rotas do jogo passam a 404 sem derrubar o servidor; o builder abandona e segue para o próximo. → testes em Task 7 e Task 11.
4. **Save PUT truncado / conexão caindo no meio**: o card anterior continua intacto (nada de arquivo pela metade). → teste em Task 3.
5. **Controle com `id` estranho ou mapa corrompido no servidor** (JSON inválido, índices fora do controle): o `pad.js` ignora o mapa ruim e devolve o controle cru, sem quebrar o jogo. → teste em Task 8.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| `server/iso9660.ts` (novo) | Lê o `SYSTEM.CNF` de um disco por `read(offset, len)`; serial e id normalizados. Também empacotado como `iso.js` para a página. |
| `server/testing/iso.ts` (novo) | Só para testes: monta uma ISO9660 mínima em memória com arquivos dados. |
| `server/library.ts` (novo) | Jogos de PS2 no volume: reservar, listar, renomear, remover, recompilar, conferir a ISO completa; cada jogo com o seu `DiscStore`. |
| `server/saves.ts` (novo) | Memory cards por jogo e pessoa. |
| `server/people.ts` (novo) | Mapas de controle e último jogo de cada pessoa. |
| `server/cover.ts` (novo) | Capa enviada → WebP 600×900; capa gerada (SVG) a partir do serial. |
| `server/ps2rooms.ts` (novo) | Salas do online dos jogos de PS2 (sinalização com long-poll). |
| `server/ice.ts` (novo) | Servidores ICE (STUN e TURN com credencial temporária). |
| `server/http.ts` (novo) | Respostas com Range (arquivo inteiro, 206, 416, HEAD) e injeção do `pad.js` no HTML. |
| `server/routes.ts` (modificar) | Liga tudo nas rotas novas; BT3 intacto. |
| `server/index.ts` (modificar) | Empacota `iso.js` e `pad.js`, lê `PUBLIC_URL`/`TURN_*`, cria a biblioteca. |
| `page/padmap.ts` (novo) | Tipos e tradução de controle (`Mapping`, `remap`), sem DOM: usado pelo `pad.ts`, pela home e pelo servidor (validação). |
| `page/pad.ts` (novo) | O shim de `navigator.getGamepads()` injetado nos jogos. |
| `page/entry.ts` (modificar) | Ouve `cordplay:open` e chama `openExternalLink`. |
| `page/index.html` (reescrever) | A home nova. |
| `page/home/*.js` (novos) | Partes da home em JS puro: `library.js`, `drawer.js`, `wizard.js`, `controller.js`, `intro.js`; `page/home/art.svg` (ilustrações). |
| `ps2-builder/patch.ts` (novo) | Patch fail-loud do `web/shell.html`. |
| `ps2-builder/builder.ts` (novo) | Laço: fila, `port.sh`, passos, publicação. |
| `ps2-builder/shots.py` (novo) | Converte as últimas capturas PPM em WebP (Pillow). |
| `ps2-builder/Dockerfile`, `.dockerignore`, `fixtures/shell.html` (novos) | Imagem e o trecho real do shell para os testes. |
| `scripts/pass.ts` (novo) | Só desenvolvimento: imprime um passe assinado para abrir a home sem o Discord. |
| `docker-compose.yml`, `README.md`, `.dockerignore` (modificar) | Serviço `ps2-builder`, `turn` comentado, variáveis novas, documentação. |

Chave de jogo usada por toda a feature: `"bt3"` para o port, `"ps2/<id>"` para os jogos de PS2.

---

### Task 0: Ambiente

**Files:** Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Instalar o Bun na máquina de desenvolvimento** — `winget install --id Oven-sh.Bun -e --silent`; abrir um shell novo; `bun --version` mostra `1.4.x`.
- [ ] **Step 2: Rodar a suíte atual** — `bun install && bun test && bun run typecheck`. Esperado: 34 testes passando, typecheck limpo. (Se a rede bloquear o registro do npm por certificado, `bun install` usa `NODE_EXTRA_CA_CERTS` apontando para o certificado da rede; nunca desligar verificação.)
- [ ] **Step 3: Dependências novas** — `bun add sharp @fontsource-variable/inter @fontsource-variable/space-grotesk`.
- [ ] **Step 4: Commit** — `git commit -am "Deps: sharp e as fontes da home"`.

---

### Task 1: Ler o `SYSTEM.CNF` (ISO9660)

**Files:**
- Create: `server/iso9660.ts`, `server/testing/iso.ts`
- Test: `server/iso9660.test.ts`

**Interfaces:**
- Produces:
  - `type Read = (offset: number, length: number) => Promise<Uint8Array>`
  - `interface DiscId { serial: string /* "SLUS-21678" */; id: string /* "slus-21678" */; boot: string /* "cdrom0:\\SLUS_216.78;1" */ }`
  - `readDiscId(read: Read): Promise<DiscId | null>`
  - `fileRead(path: string): Read` (via `Bun.file(path).slice`)
  - `const BT3_SERIAL = "SLUS-21678"`
  - (teste) `makeIso(files: Record<string, string | Uint8Array>, { pad?: number }): Uint8Array`

Algoritmo (não determinado pela assinatura): setores de 2048; descritor primário no setor 16 (`data[16*2048] === 1` e `"CD001"` em 1..5); registro do diretório raiz no byte 156 do descritor (extent LE em +2, tamanho LE em +10); percorrer os registros (tamanho em +0, extent +2, tamanho do dado +10, tamanho do nome +32, nome em +33; registro de tamanho 0 pula para o próximo setor); achar `SYSTEM.CNF;1` (sem diferenciar maiúsculas, `;1` opcional); ler o arquivo; `BOOT2\s*=\s*(cdrom0:\\?[^\r\n]+)`; o nome do programa é o que vem depois da última `\` até `;`; serial = `/^([A-Z]{4})_(\d{3})\.(\d{2})$/` → `"$1-$2$3"`; nome fora desse formato → `null`.

- [ ] **Step 1: Testes que falham** em `server/iso9660.test.ts`:
  - `"reads the serial from SYSTEM.CNF"`: `makeIso({ "SYSTEM.CNF": "BOOT2 = cdrom0:\\SLUS_216.78;1\r\nVER = 1.00\r\n" })` → `{ serial: "SLUS-21678", id: "slus-21678", boot: "cdrom0:\\SLUS_216.78;1" }`.
  - `"no SYSTEM.CNF, no BOOT2, or not an ISO is null"`: ISO só com `README.TXT` → `null`; `SYSTEM.CNF` com `BOOT = cdrom:\\SLPS_123.45;1` (PS1) → `null`; 64 KB de zeros → `null`.
  - `"finds it past other entries and in lower case"`: 40 arquivos antes (força mais de um setor de diretório) e `system.cnf;1` → serial lido.
  - `"fileRead reads slices of a file"`: grava a ISO num temp e lê o mesmo serial com `fileRead`.
- [ ] **Step 2:** `bun test server/iso9660.test.ts` → FAIL (`readDiscId` não existe).
- [ ] **Step 3:** Implementar `makeIso` (descritor primário + raiz + arquivos alinhados a setor, preenchimento opcional `pad` bytes no fim) e `readDiscId`/`fileRead`.
- [ ] **Step 4:** `bun test server/iso9660.test.ts` → PASS; `bun run typecheck` limpo.
- [ ] **Step 5: Commit** — `"ISO9660: o serial do disco pelo SYSTEM.CNF"`.

---

### Task 2: Biblioteca de PS2

**Files:**
- Create: `server/library.ts`
- Modify: `server/upload.ts` (só exportar `QUIET_MS` já existe; nada mais)
- Test: `server/library.test.ts`

**Interfaces:**
- Consumes: `readDiscId`, `fileRead`, `BT3_SERIAL` (Task 1); `createDiscStore`, `DiscStore`, `Status` (`server/upload.ts`); `Pass` (`server/pass.ts`).
- Produces:
  - `interface Ps2Game { id: string; serial: string; name: string; by: { id: string; name: string }; at: number; cover: boolean }` (= `game.json`)
  - `const PS2_MIN = 100 * 1024 ** 2`, `const PS2_MAX = 9 * 1024 ** 3`, `const ABANDONED_MS = 24 * 60 * 60_000`, `const ID = /^[a-z]{4}-\d{5}$/`
  - `createLibrary(dir: string /* /app/data */, { now?, min?, max? })` →
    - `list(): Promise<Ps2Game[]>` (ordem: `at` mais novo primeiro; apaga reservas `empty` com `at` > 24 h)
    - `get(id: string): Promise<Ps2Game | null>` (null para id fora do `ID`)
    - `reserve(pass: Pass, serial: string, name: string): Promise<{ ok: true; game: Ps2Game } | { ok: false; exists: string }>` (`exists` = chave: `"bt3"` para `BT3_SERIAL`, `"ps2/<id>"` se já há pasta)
    - `disc(id: string): DiscStore` (memoizado; `createDiscStore(join(dir,"ps2",id), { now, min, max })`)
    - `verify(id: string): Promise<{ ok: true } | { ok: false; message: string }>` (lê `disc.iso`; serial diferente → apaga a pasta, `"A ISO não é do jogo escolhido"`; sem serial → apaga, `"Isso não parece um disco de PS2"`)
    - `rename(id, name)`, `setCover(id, has: boolean)`, `remove(id)` (apaga `ps2/<id>` e `ps2-work/<id>`, mantém `saves/<id>`), `rebuild(id)` (apaga `build/`, escreve `retry`)
    - `paths(id)`: `{ root, game, build, iso, cover, work }`

Nome: `trim()`, 1–80 caracteres, senão o serial. Reserva cria a pasta com `mkdir` **sem** `recursive` no último nível, para que duas reservas simultâneas do mesmo serial não passem (a segunda pega `EEXIST` → `exists`).

- [ ] **Step 1: Testes que falham** em `server/library.test.ts` (relógio injetado, pasta temp):
  - `"reserve makes the game folder and game.json; list shows it"`.
  - `"the same serial twice, even at the same time, is one game"`: `Promise.all([reserve(ana,"SLES-12345","A"), reserve(bia,"SLES-12345","B")])` → exatamente um `ok`, o outro `{ ok:false, exists:"ps2/sles-12345" }`; uma pasta só.
  - `"BT3's serial points at BT3"`: `reserve(ana, "SLUS-21678", "x")` → `{ ok:false, exists:"bt3" }`.
  - `"verify keeps a matching disc and drops a wrong or foreign one"`: grava `makeIso` com o serial reservado em `disc.iso` → `{ok:true}`; com outro serial → `{ ok:false, message:"A ISO não é do jogo escolhido" }` e `get(id)` é `null`; sem `SYSTEM.CNF` → `"Isso não parece um disco de PS2"`.
  - `"rename, cover flag, rebuild and remove (saves stay)"`: `remove` deixa `saves/<id>/42.ps2` no lugar; `rebuild` apaga `build/` e cria `retry`.
  - `"an abandoned reservation goes after 24 h; one with an upload under way stays"`.
  - `"ids from outside never reach the disk"`: `get("../bt3")`, `get("SLUS-21678")` → `null`.
- [ ] **Step 2:** `bun test server/library.test.ts` → FAIL.
- [ ] **Step 3:** Implementar `createLibrary`.
- [ ] **Step 4:** `bun test server/library.test.ts` → PASS.
- [ ] **Step 5: Commit** — `"Biblioteca: jogos de PS2 no volume, um por serial"`.

---

### Task 3: Saves, mapas de controle e último jogo

**Files:**
- Create: `page/padmap.ts` (só os tipos e `validMapping` aqui; `remap` vem na Task 8), `server/saves.ts`, `server/people.ts`
- Test: `server/saves.test.ts`, `server/people.test.ts`

**Interfaces:**
- Produces:
  - `page/padmap.ts`: `type Source = { button: number } | { axis: number; dir: 1 | -1 } | { hat: number; value: number }`; `interface AxisSource { axis: number; invert?: boolean }`; `interface Mapping { buttons: (Source | null)[] /* 16, ordem standard */; axes: (AxisSource | null)[] /* 4 */ }`; `validMapping(m: unknown): m is Mapping` (16 e 4 entradas; índices inteiros 0–63; `value` finito em [-1,1]).
  - `server/saves.ts`: `const CARD_BYTES = 8_650_752`, `const CARD_MAGIC = "Sony PS2 Memory Card Format "`; `createSaves(dir /* /app/data */)` → `get(game: string, user: string): Promise<Uint8Array | null>`, `put(game, user, body: Uint8Array): Promise<{ ok: true } | { ok: false; error: string }>` (grava `saves/<game>/<user>.ps2.tmp` e renomeia).
  - `server/people.ts`: `createPeople(dir)` → `pads(user): Promise<Record<string, Mapping>>`, `setPads(user, maps: unknown): Promise<boolean>` (rejeita se algum valor não passa em `validMapping`, mais de 16 controles, ou `id` > 200 chars), `last(user): Promise<string | null>`, `played(user, key: string): Promise<void>`.
  - User ids (do passe, só dígitos no Discord) passam por `/^[\w-]{1,40}$/` antes de virar nome de arquivo; fora disso, `get`/`pads`/`last` → vazio e `put`/`setPads` → erro.

- [ ] **Step 1: Testes que falham**:
  - saves: `"a card of the right size and header is kept per game and person"`; `"wrong size or header is refused and the old card stays"` (put válido, depois put de 100 bytes → `{ok:false}`, `get` devolve o válido); `"a write that dies midway leaves the old card"` (simular: `.tmp` sobrando de uma escrita anterior não afeta `get`); `"ids that aren't plain are refused"` (`"../x"`).
  - people: `"pads round-trip; a bad mapping is refused whole"` (um mapa com 15 botões → `false`, nada gravado); `"played and last"`; `"a corrupted pads file reads as none"` (grava `{` em `pads/42.json` → `pads("42")` é `{}`).
- [ ] **Step 2:** `bun test server/saves.test.ts server/people.test.ts` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** — `"Saves e mapas de controle por pessoa"`.

---

### Task 4: Capas

**Files:**
- Create: `server/cover.ts`
- Test: `server/cover.test.ts`

**Interfaces:**
- Produces: `const COVER_MAX = 5 * 1024 ** 2`; `normalizeCover(body: Uint8Array): Promise<{ ok: true; webp: Uint8Array } | { ok: false; error: string }>` (sharp: `rotate()`, `resize(600, 900, { fit: "cover", position: "attention" })`, `webp({ quality: 82 })`; aceita só `png`, `jpeg`, `webp` pelo `metadata().format`); `generatedCover(serial: string, name: string): string` (SVG 600×900).

`generatedCover`: matiz = `(hash(serial) % 60) + 245` (faixa do roxo ao violeta); fundo `#0b0a14`; duas formas (um círculo e um polígono escolhidos pelo hash) com `linearGradient` de `hsl(h 100% 66%)` a `#a08cff`, cortadas pela borda; o nome em Space Grotesk 600, 44 px, embaixo, quebrado em até 3 linhas de 18 caracteres, com XML escapado.

- [ ] **Step 1: Testes que falham**:
  - `"a png becomes a 600x900 webp"` (gera um PNG 1000×1000 com sharp no teste; `metadata` do resultado = `webp`, 600×900).
  - `"too big, not an image, or another format is refused"` (> 5 MB; bytes aleatórios; um GIF 1×1) → `ok:false` com mensagem.
  - `"the generated cover is the same for the same game, escapes the name and differs between games"`: duas chamadas iguais → mesma string; `name = "<Tom & Jerry>"` → contém `&lt;Tom &amp; Jerry&gt;`; seriais diferentes → strings diferentes.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5: Commit** — `"Capas: a enviada em WebP 600x900, ou uma gerada pelo serial"`.

---

### Task 5: Salas do online e ICE

**Files:**
- Create: `server/ps2rooms.ts`, `server/ice.ts`
- Test: `server/ps2rooms.test.ts`, `server/ice.test.ts`

**Interfaces:**
- Produces:
  - `const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"`, `const ROOM_IDLE_MS = 3_600_000`, `const WAIT_MS = 20_000`, `const MESSAGE_MAX = 65_536`
  - `class Ps2Rooms { constructor(now = Date.now, random = Math.random, setTimer = setTimeout) ; create(game: string, host: { id: string; name: string }): string; post(code: string, to: string, message: unknown): boolean /* false: sem sala */; wait(code: string, me: string, after: number, ms = WAIT_MS): Promise<{ messages: unknown[]; next: number } | null /* sala sumiu */>; list(game: string): { code: string; host: string; since: number; busy: boolean }[] }`
  - `busy` = já chegou ao `host` uma mensagem `{ type: "join" }` de um `from` que ainda não enviou `{ type: "bye" }` (o shell manda `join`; a sala volta a livre quando o convidado some por mais de 30 s sem `GET`).
  - `iceServers({ turnUrl, turnSecret, user, now }: { turnUrl?: string; turnSecret?: string; user: string; now: number }): { urls: string | string[]; username?: string; credential?: string }[]` — sempre `{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }`; com as duas variáveis, mais `{ urls: turnUrl, username: \`${Math.floor(now/1000) + 43200}:${user}\`, credential: base64(HMAC-SHA1(turnSecret, username)) }`.
- Mensagens só para `to`/`me` em `/^[a-z0-9]{1,16}$/` (como o `serve.py`); `post` com `message` que não é objeto → `false` na rota (400).

- [ ] **Step 1: Testes que falham**:
  - `"a room gets a fresh 6-letter code and is listed for its game only"`.
  - `"a message reaches the right inbox; wait returns at once when there is one"`.
  - `"wait sleeps until a message arrives, or returns empty after 20 s"` (temporizador injetado).
  - `"an idle room goes after an hour; wait on it is null"`.
  - `"busy once a guest joined, free again when it left or went quiet"`.
  - ice: `"stun only without TURN settings"`; `"turn with a 12 h coturn REST credential"` (username e credential exatos para `now = 1_700_000_000_000`, `user = "42"`, `turnSecret = "s3cret"`: calcular o esperado no teste com `createHmac("sha1", ...)`).
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5: Commit** — `"Online dos jogos de PS2: salas e servidores ICE"`.

---

### Task 6: Rotas da biblioteca

**Files:**
- Modify: `server/routes.ts`, `server/games.ts` (adiciona `export const PS2_STEPS = ["Lendo o disco", "Executável", "Traduzindo para C++", "Explorando o jogo", "Unidades vetoriais", "Compilando a página"]`), `server/upload.ts` (`BuilderStatus` ganha `note?: string; shots?: number; reason?: string`)
- Test: `server/routes.test.ts` (novos testes num `describe("ps2 library")`, mesma montagem do arquivo, com a biblioteca na pasta temp)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces (`AppOptions` ganha): `library?: ReturnType<typeof createLibrary>`, `saves?`, `people?`, `rooms?: Ps2Rooms`, `publicUrl?: string`, `turn?: { url: string; secret: string }`, `isoJs?: string`, `padJs?: string`. Sem `library`, as rotas de PS2 respondem 404 (os testes antigos não mudam).
- `GET games` passa a responder: `{ me, last, publicUrl, games: CatalogEntry[] }` com `CatalogEntry = { key: string; kind: "port" | "recomp"; id: string; name: string; serial?: string; platform: string; year?: number; tags: string[]; blurb?: string; disc?: string; steps: string[]; minIso: number; maxIso: number; cover: string /* URL relativa */; colors?: [string,string]; status: Status; rooms: number; open: { code: string; host: string; since: number; busy: boolean }[]; by?: string; note?: string; shots: number }`. Para o BT3, `key "bt3"`, `kind "port"`, `cover "cover/bt3"`, `open []`, `rooms` como hoje. Para PS2, `status` do `disc(id).status(pass)` com os passos do `ps2-builder`; `note` e `shots` do `status.json` (`BuilderStatus` ganha `note?: string; shots?: number`).

Rotas (seção "Rotas novas" da spec), com estes detalhes:
- `POST ps2` `{ serial, name }` → 201 `{ key, id }` | 409 `{ exists }` | 400 (serial fora de `/^[A-Z]{4}-\d{5}$/`).
- `PUT ps2/<id>/upload` = o do BT3; quando `done`, chama `library.verify(id)`; se falhar, 400 `{ error: message, code: "disc" }`.
- `PATCH ps2/<id>` `{ name }` → 204. `PUT ps2/<id>/cover` (corpo bruto, `content-length` > `COVER_MAX` → 413) → 204; `DELETE ps2/<id>/cover` → 204. `POST ps2/<id>/rebuild` → 204. `DELETE ps2/<id>` → 204.
- `GET cover/<key>`: WebP salvo (`image/webp`) ou `generatedCover` (`image/svg+xml`); BT3 → SVG gerado com o nome e as `colors` dele. `Cache-Control: private, max-age=31536000, immutable` (a página põe `?v=<at>`).
- `GET/PUT ps2/<id>/save` (corpo bruto ≤ `CARD_BYTES`), `GET/PUT pad` (JSON), `POST played` `{ key }` (só chaves que existem).

- [ ] **Step 1: Testes que falham** (novos, no `routes.test.ts`):
  - `"games lists BT3 and the PS2 games, each with its key, cover and state"`.
  - `"reserve, upload in pieces and the disc is checked when complete"` (ISO de `makeIso` com `pad` para passar de `min` — usar `createLibrary(..., { min: 1024 })` no teste).
  - `"a disc with another serial is dropped after the upload"` → 400 `code "disc"`, jogo sumiu de `games`.
  - `"rename, cover (webp, generated, too big) and remove"`.
  - `"saves: one per person, never another's"` (passe de Ana grava; um segundo passe fake `Bia` lê 404).
  - `"pad maps and the last game played round-trip"`.
  - `"PS2 routes 404 for unknown ids and without a library"`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar em `routes.ts` (funções por grupo de rota, como o `game()` de hoje). **Step 4:** `bun test` inteiro → PASS (os 34 antigos inclusos).
- [ ] **Step 5: Commit** — `"Rotas da biblioteca de PS2: reservar, enviar, capa, saves, controle"`.

---

### Task 7: Servir o jogo de PS2, Range, intro e salas

**Files:**
- Create: `server/http.ts`
- Modify: `server/routes.ts`, `server/index.ts`, `.dockerignore` (nada de `page/home` fora), `README.md` (variáveis)
- Test: `server/http.test.ts`, `server/routes.test.ts`

**Interfaces:**
- Produces (`server/http.ts`):
  - `rangeResponse(req: Request, file: BunFile, headers: Record<string,string>): Response` — `HEAD` sem corpo; sem `Range` 200 com `Accept-Ranges: bytes`; `bytes=a-b`, `bytes=a-`, `bytes=-n` → 206 com `Content-Range`; inválido ou fora → 416 `Content-Range: bytes */<size>`.
  - `injectPad(html: string, src: string): string | null` — insere `<script src="${src}"></script>` antes do primeiro `</head>` (sem diferenciar maiúsculas); `null` se não houver.
  - `const ISOLATED = { "Content-Security-Policy": FRAME_ANCESTORS, "Document-Isolation-Policy": "isolate-and-require-corp", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-cache" }`
- `PS2_FILES = new Set(["ps2web.js", "ps2web.wasm", "ps2web.data"])`; `game/` e `game/index.html` → `build/ps2web.html` com `injectPad(html, "../../../pad.js")`; `.gz` quando `accept-encoding` tem `gzip` e existe `<arquivo>.gz` (com `Content-Encoding: gzip`, `Vary: Accept-Encoding`); `game/shots/NN.webp` (`/^shots\/\d{2}\.webp$/`).
- BT3: o `index.html` do jogo passa por `injectPad(html, "../../pad.js")` (se `null`, serve sem e `console.warn` uma vez).
- `game/disc.iso` → `rangeResponse` com `ISOLATED`. `game/room*` → `Ps2Rooms` (POST `room` cria com o nome do passe; 64 KB → 413; JSON inválido → 400); `game/ice` → `iceServers(...)` com `user = pass.id`.
- `intro.mp4` → `rangeResponse` de `<dir>/intro.mp4` (404 sem o arquivo), cabeçalhos de hoje. `pad.js`, `iso.js` → os textos empacotados. `fonts/<arquivo>.woff2` → de `node_modules/@fontsource-variable/{inter,space-grotesk}/files/` (lista fixa: `inter-latin-wght-normal.woff2`, `space-grotesk-latin-wght-normal.woff2`).
- `index.ts`: `Bun.build` também de `page/pad.ts` (`iife`) e de `server/iso9660.ts` (formato `iife`, `globalName: "CordISO"`); lê `PUBLIC_URL` (sem barra final), `TURN_URL`, `TURN_SECRET`; cria `createLibrary`, `createSaves`, `createPeople`, `new Ps2Rooms()`. `PUBLIC_URL` entra também no `define` do `entry.ts` (`process.env.PUBLIC_URL`).

- [ ] **Step 1: Testes que falham**:
  - http: `"range: whole, a slice, an open end, a suffix, HEAD"`; `"range out of the file or malformed is 416"` (`bytes=5000000000-`, `bytes=abc`, `bytes=10-5`); `"injectPad before </head>, null without it"`.
  - routes: `"a PS2 game is served isolated, from its fixed list, gzipped when asked"` (cabeçalhos `ISOLATED`, sem `sandbox`; `ps2web.html` traz o `<script src="../../../pad.js">`; `build/segredo.txt` → 404).
  - `"the disc of a PS2 game answers Range and HEAD"`.
  - `"BT3's page gets pad.js, everything else of BT3 is as before"`.
  - `"a removed game's routes 404 while open"` (remove e pede `game/disc.iso` → 404, servidor responde).
  - `"rooms: create, post, wait, listed in games; ice with and without TURN"`.
  - `"intro with Range, 404 without the file"`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** `bun test` → PASS; `bun run typecheck` limpo.
- [ ] **Step 5:** Smoke: `DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=y bun run start` sobe e `curl -sI localhost:3003/` dá 200.
- [ ] **Step 6: Commit** — `"Jogo de PS2 isolado, disco com Range, intro, salas e ICE"`.

---

### Task 8: `pad.js`, o controle mapeado nos jogos

**Files:**
- Modify: `page/padmap.ts` (adicionar `remap`, `STANDARD`)
- Create: `page/pad.ts`
- Test: `page/pad.test.ts`

**Interfaces:**
- Consumes: `Mapping`, `Source`, `validMapping` (Task 3); `GET ../pad` relativo ao jogo (Task 6).
- Produces:
  - `const STANDARD = ["cross","circle","square","triangle","l1","r1","l2","r2","select","start","l3","r3","up","down","left","right"] as const` (índices do layout standard do W3C).
  - `interface PadLike { id: string; index: number; connected: boolean; timestamp: number; mapping: string; buttons: readonly { pressed: boolean; touched: boolean; value: number }[]; axes: readonly number[]; vibrationActuator?: unknown }`
  - `remap(raw: PadLike, m: Mapping): PadLike` — `mapping: "standard"`, 16 botões, 4 eixos; botão por `{button}` copia `value`; `{axis,dir}` pressionado se `axis*dir > 0.5`, `value` = `max(0, axis*dir)`; `{hat,value}` pressionado se `|axes[hat] - value| < 0.1`; eixo `{axis, invert}`; origem inexistente no controle → solto/0; mantém `vibrationActuator`.
  - `install(nav: { getGamepads(): (PadLike | null)[] }, maps: Record<string, Mapping>): void` — troca `nav.getGamepads` por uma que aplica `remap` a quem tem mapa válido (`validMapping`), e devolve os outros crus.
  - `pad.ts` (entrada do bundle): `fetch("../pad")` relativo à página (`new URL(...)` a partir do `<script src>`, já que BT3 e PS2 ficam em profundidades diferentes) e `install(navigator, maps)`; se a chamada falhar, não instala nada.

- [ ] **Step 1: Testes que falham** em `page/pad.test.ts`:
  - `"buttons, axes as buttons, and a hat d-pad"` (controle cru de adaptador: d-pad no eixo 9 com valores −1, −0.43, 0.14, 0.71).
  - `"inverted sticks"`.
  - `"no map, or a broken one, gives the raw pad"` (mapa com `buttons` de 3 entradas → cru; `{ button: 99 }` num controle de 12 botões → solto, sem erro).
  - `"install keeps nulls and vibration"`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5: Commit** — `"pad.js: controle de PS2 mapeado vira o layout standard nos jogos"`.

---

### Task 9: "Abrir no navegador" pela página de entrada

**Files:**
- Modify: `page/entry.ts`
- Test: `page/entry.test.ts`

**Interfaces:**
- Produces: `openRequest(data: unknown, publicUrl: string): string | null` (exportada de `page/entry.ts` para teste). Dentro do Discord a página está no proxy `*.discordsays.com`, então quem pede manda só o **caminho**: `{ t: "cordplay:open", path }`, com `path` casando `^/p/[\w.-]+/(ps2/[a-z]{4}-\d{5}/game/|)$` (o jogo, ou a home para a tela de controle) → `publicUrl + path`; qualquer outra coisa, ou `publicUrl` vazio → `null`. O `start()` adiciona `window.addEventListener("message", ...)` que chama `sdk.commands.openExternalLink({ url })` com o resultado.
- Para testar sem o SDK, o `start()` só roda quando `typeof document !== "undefined"`; o teste importa só `openRequest`.

- [ ] **Step 1: Teste que falha**: `"only our own pages are opened outside"` (`{ t:"cordplay:open", path:"/p/abc/ps2/slus-21678/game/" }` → `${publicUrl}/p/abc/ps2/slus-21678/game/`; `path:"/p/abc/"` → a home; `path:"//evil.com/p/x"`, `path:"/p/abc/../../x"`, `{ t:"outro" }` → null; `publicUrl` vazio → null).
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS.
- [ ] **Step 5: Commit** — `"Entrada: abrir o jogo no navegador quando o Discord não isola"`.

---

### Task 10: Patch do `shell.html` do ps2-web-recomp

**Files:**
- Create: `ps2-builder/patch.ts`, `ps2-builder/fixtures/shell.html` (cópia do `web/shell.html` do commit fixo; arquivo de código MIT, sem nada de jogo)
- Test: `ps2-builder/patch.test.ts`

**Interfaces:**
- Produces: `patchShell(html: string): string` — mesmo estilo do `builder/patch.ts` (`apply` com trocas exatas; erro `"shell.html: não achei o trecho …"`; `check` final sem resto do que foi trocado).

Trocas (texto exato de origem no commit fixo):
1. **Saves:** o bloco do `preRun` que começa em `FS.mkdir(CARD_DIR);\n        FS.mount(IDBFS, {}, CARD_DIR);` até o `catch` → `FS.mkdir(CARD_DIR)` e `Module.addRunDependency('card'); fetch('../save', { cache: 'no-store' }).then((r) => r.ok ? r.arrayBuffer() : null).then((b) => { if (b) FS.writeFile(CARD_FILE, new Uint8Array(b)); }).catch((e) => console.warn('memory card: could not load from the server', e)).finally(() => Module.removeRunDependency('card'));`.
2. **storeCard:** `FS.syncfs(false, (err) => {` … → `let data = null; try { data = FS.readFile(CARD_FILE); } catch (e) {} if (!data) { if (then) then(); return; } fetch('../save', { method: 'PUT', body: data }).catch((err) => console.warn('memory card: could not save on the server', err)).finally(() => { if (then) then(); });` (mantendo o `setTimeout` de 300 ms).
3. **Isolation:** `if (missing.length) {\n  const help = ...` → se `missing` tem só o item de isolation e `window.parent !== window`, o `help` vira o texto *"O Discord não liberou o modo que esse jogo precisa nesta janela."* com um botão `Abrir no navegador` que faz `parent.postMessage({ t: 'cordplay:open', path: location.pathname }, '*')` (formato da Task 9) e o `start` fica "Abrir no navegador"; senão o texto atual em português: *"Este navegador ainda não roda o jogo. Falta: … Um Chrome ou Edge atualizado tem tudo."*
4. **Online:** `const rtcConfig = { iceServers: [...] };` → `let rtcConfig = { iceServers: [...] }; fetch('ice').then((r) => r.ok ? r.json() : null).then((s) => { if (s) rtcConfig = { iceServers: s }; }).catch(() => {});`; `inviteButton` título/texto: `'Invite'` → `'Abrir sala'`, `'Room ' + room` → `'Sala ' + room`; `copyInvite()` → `note('Sala ' + room + ': os amigos entram pela biblioteca do CordPlay')`; textos do convidado (`'Join room '`, `'Invited to room '`, `'Joining room '`, `'Playing as player 2 in room '`, `' does not exist any more.'`) em português; mais um tempo de 15 s no convidado que, sem `connected`, mostra *"Não deu para conectar com o host. Talvez a rede de um dos dois bloqueie; o servidor precisa de um TURN."*

- [ ] **Step 1: Testes que falham** com a fixture real:
  - `"saves go to the server instead of the browser"` (sem `IDBFS`, com `fetch('../save'`, `method: 'PUT'`).
  - `"isolation missing in a frame offers the browser"` (contém `cordplay:open` e `Abrir no navegador`).
  - `"rooms: ice from the server, Portuguese labels, no link copy"` (sem `clipboard.writeText(link)`, contém `fetch('ice')`, `Abrir sala`).
  - `"fails loudly when a piece is missing"` (remover cada trecho de origem, um por vez → erro com o trecho no texto).
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** `bun test ps2-builder page` → PASS.
- [ ] **Step 5: Commit** — `"ps2-builder: patch do shell (saves no servidor, navegador, salas)"`.

---

### Task 11: Laço do `ps2-builder`

**Files:**
- Create: `ps2-builder/builder.ts`, `ps2-builder/shots.py`
- Test: `ps2-builder/builder.test.ts`

**Interfaces:**
- Consumes: `patchShell` (Task 10); layout do volume (Task 2); `BuilderStatus` com `note`, `shots` (Task 6).
- Produces:
  - `PS2_STEPS` de `server/games.ts` (criado na Task 6; a imagem do `app` não tem `ps2-builder/`), importado de `../server/games`.
  - `type Runner` igual ao de `builder/builder.ts` (importar de lá).
  - `createPs2Builder({ data, repo, run, python = "python3", rounds = 4, frames = 3600, now })` → `{ tick(): Promise<void>; beat(): Promise<void> /* sinal de vida em todos os ps2/*/status.json com disc.iso */; current: string | null }`.
  - `prepare()` (no começo, uma vez): grava `patchShell(web/shell.html)` em `repo/web/shell.html` se ainda não tiver sido (marcador `<!-- cordplay -->` no fim).
  - Por jogo: links `repo/games/<id>` → `data/ps2-work/<id>/game`, `repo/generated/<id>` → `…/generated`, `repo/build/web-<id>` → `…/web`, `repo/build/native-<id>` → `…/native`; comando `["bash", "scripts/port.sh", id, "<data>/ps2/<id>/disc.iso", "--rounds", rounds, "--frames", frames]` com `cwd: repo`; o `log` do runner procura `^== \[(\d)\/6\]` e atualiza o passo; `explore.log` dá o `note` (`[ee] halted: …`); falha → `message` = fim do log, `reason` = primeira linha `[sys] unhandled syscall…` ou `[iop] missing …` do `explore.log`, se houver; `ENOSPC` → `"Sem espaço no servidor"` e apaga `ps2-work/<id>`.
  - Publicar: `ps2web.{html,js,wasm,data}` e os `.gz` de `web-<id>` → `build.tmp/`; `python3 shots.py <games/<id>/shots> <build.tmp/shots> 6` (as 6 últimas `frame_*.ppm` por nome → `01.webp`…, devolve quantas); troca por `build/`; `status = { state:"ready", iso, note, shots }`.
  - Fila: o jogo com `disc.iso` e sem `build/index…`/`build/ps2web.html`, ou com `retry`, de menor `game.json.at`; jogo `failed` com o mesmo `iso` e sem `retry` é pulado; se a pasta sumir durante a compilação, o resultado é descartado e nada é publicado.

- [ ] **Step 1: Testes que falham** (runner falso que escreve os arquivos do `port.sh` e imprime `== [n/6] …`; `shots.py` também falso):
  - `"nothing to build: heartbeat only"`.
  - `"one game at a time, oldest first; the others stay queued"`.
  - `"steps follow port.sh's output; publish swaps build/ with the page, gz and shots"`.
  - `"a failing port.sh is failed with the log's end and the reason from explore.log"`.
  - `"retry builds again; a removed game is dropped midway without publishing"`.
  - `"the shell is patched once before the first build"`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar (`shots.py` com Pillow: `Image.open(ppm).save(webp, quality=80)`). **Step 4:** → PASS.
- [ ] **Step 5: Commit** — `"ps2-builder: fila, port.sh e publicação"`.

---

### Task 12: Imagem, compose e documentação

**Files:**
- Create: `ps2-builder/Dockerfile`, `ps2-builder/.dockerignore`
- Modify: `docker-compose.yml`, `README.md`, `.dockerignore`, `tsconfig.json` (`include` ganha `ps2-builder`)

Dockerfile (contexto de build = raiz do repo, porque o builder importa `builder/builder.ts` e `server/games.ts`): `FROM oven/bun:1.4 AS bun`; `FROM debian:trixie-slim`; `apt-get install clang cmake ninja-build python3 python3-pil p7zip-full git ca-certificates curl xz-utils bash`; `COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun`; `ARG RECOMP_REPO=https://github.com/snuri00/ps2-web-recomp.git`, `ARG RECOMP_COMMIT=e026b971324068773eed88bf502437de9e581b6b`; clone no commit em `/opt/recomp` (mesmo padrão `init/fetch --depth 1/checkout` do `builder/Dockerfile`); `RUN EMSDK=/opt/recomp/tools/emsdk /opt/recomp/scripts/setup.sh`; `WORKDIR /opt/cordplay`; `COPY builder/builder.ts builder/patch.ts builder/`, `COPY server/games.ts server/`, `COPY ps2-builder/builder.ts ps2-builder/patch.ts ps2-builder/shots.py ps2-builder/`; `ENV RECOMP=/opt/recomp DATA=/app/data`; `CMD ["bun", "ps2-builder/builder.ts"]`. Variáveis `PS2_ROUNDS`, `PS2_FRAMES`.

Compose: serviço `ps2-builder` (`build: { context: ., dockerfile: ps2-builder/Dockerfile }`, `cpus: "2"`, `restart: unless-stopped`, volume `bt3-data:/app/data`); `app` ganha `PUBLIC_URL`, `TURN_URL`, `TURN_SECRET` (`${VAR:-}`); serviço `turn` (coturn) **comentado** com `--use-auth-secret --static-auth-secret=${TURN_SECRET}`, portas `3478/udp`, `3478/tcp`, `49160-49200/udp` e a nota do firewall.

README: seção "Jogos de PS2" (como adicionar, o aviso de compatibilidade, onde ficam os arquivos, `intro.mp4` no volume, saves, controle, online e TURN, "Abrir no navegador" e `PUBLIC_URL`); tabela de variáveis; "Por dentro" com os módulos novos.

- [ ] **Step 1:** Escrever os arquivos.
- [ ] **Step 2:** `docker build -f ps2-builder/Dockerfile .` termina (demora: emsdk + wgpu-native). Se o Docker não estiver disponível na máquina, registrar no commit que a imagem não foi construída aqui.
- [ ] **Step 3:** `docker compose config` sem erro.
- [ ] **Step 4:** `bun test && bun run typecheck` → PASS.
- [ ] **Step 5: Commit** — `"ps2-builder: imagem e compose; README dos jogos de PS2"`.

---

### Task 13: Home nova — base, biblioteca e gaveta

**Files:**
- Rewrite: `page/index.html`
- Create: `page/home/library.js`, `page/home/drawer.js`, `page/home/art.svg`, `scripts/pass.ts`
- Modify: `server/routes.ts` (servir `page/home/*` sob `/p/<passe>/home/` com lista fixa)

**Interfaces:**
- Consumes: `GET games` (Task 6), `GET cover/<key>`, rotas de editar/remover/recompilar/tentar de novo (Task 6), `fonts/*` (Task 7).
- Produces: módulos ES sem build (`<script type="module">`), cada um exportando `render(state, el)` e os handlers do seu pedaço; `index.html` só monta o estado (`poll()` a cada 2 s como hoje) e chama os renders. O envio em pedaços de hoje (`upload()`, `put()`, `meter()`, `progress()`) vai para `library.js` sem mudar a lógica.
- `scripts/pass.ts <secret> [id] [name]` imprime um passe válido (usa `createPasses`), para abrir `http://localhost:3003/p/<passe>/` sem o Discord.

Conteúdo: tokens do `DESIGN.md` em `:root`; `@font-face` das duas fontes vindas de `fonts/`; lateral (Biblioteca, Adicionar jogo, Controle); destaque (último jogo da pessoa ou o primeiro pronto, capa desfocada ao fundo, selo Testado/Experimental, "Jogar"); grade de capas 2:3 com estado (ponto + texto); card "Adicionar jogo" no fim da grade; ilustração de biblioteca vazia; gaveta (seção "Home" da spec: capa, nome editável, serial, quem enviou, progresso do envio/compilação com os passos e o tempo, capturas `game/shots/NN.webp`, `note`, log de falha, Jogar / Tentar de novo / Recompilar / Remover com confirmação, salas abertas); estados `offline`, `failed` etc. iguais aos de hoje para o BT3; layout de 1 coluna < 760 px; animações do `DESIGN.md` com `prefers-reduced-motion`.

- [ ] **Step 1:** Subir local com dados falsos: `data/` com o BT3 pronto (arquivos de texto) e dois jogos de PS2 (um `ready` com 3 capturas, um `building` 3/6), `bun run start`, `bun scripts/pass.ts <secret>`.
- [ ] **Step 2:** Implementar.
- [ ] **Step 3: Verificar no navegador interno** (`mcp__Claude_Browser__*`, em 1280×800 e 375×812): grade, gaveta abre e fecha (Esc, clique fora, X), editar nome salva, remover pede confirmação e some da grade, estados certos, sem rolagem horizontal, foco visível no teclado, nada de console error. Captura de tela de cada estado para o relatório.
- [ ] **Step 4:** `bun test && bun run typecheck` → PASS (testes de rota da lista fixa de `home/*` incluídos: `"home scripts from a fixed list"`).
- [ ] **Step 5: Commit** — `"Home nova: biblioteca de capas e gaveta do jogo"`.

---

### Task 14: Home — assistente "Adicionar jogo"

**Files:**
- Create: `page/home/wizard.js`
- Modify: `page/index.html`

**Interfaces:**
- Consumes: `iso.js` (`CordISO.readDiscId(read)` com `read = (o, n) => file.slice(o, o + n).arrayBuffer().then((b) => new Uint8Array(b))`), `POST ps2`, `PUT ps2/<id>/cover`, envio de `library.js`.
- Produces: `openWizard()`.

Passos e textos exatamente como na spec (aviso com "Entendi" obrigatório; ISO com "Isso não parece um disco de PS2" e "Já está aqui" + Jogar; nome sugerido = serial, editável; capa opcional com prévia 2:3 via `object-fit: cover`). Modal com foco preso, Esc fecha (pergunta se já começou o envio).

- [ ] **Step 1:** ISO de teste: `bun -e` com `makeIso` grava `data/test.iso` (100 MiB com `pad`) com um serial novo e outra com o serial do BT3.
- [ ] **Step 2:** Implementar.
- [ ] **Step 3: Verificar no navegador interno:** o aviso trava o "Continuar" até marcar; ISO sem `SYSTEM.CNF` recusada antes do envio; serial do BT3 → "Já está aqui"; ISO nova com capa → reserva, capa aparece, envio mostra progresso, termina em "Na fila".
- [ ] **Step 4: Commit** — `"Home: assistente para adicionar jogo, com o aviso de compatibilidade"`.

---

### Task 15: Home — tela de controle

**Files:**
- Create: `page/home/controller.js`
- Modify: `page/index.html`, `server/index.ts` (empacotar `page/padmap.ts` como `padmap.js`, `globalName: "CordPad"`)

**Interfaces:**
- Consumes: `CordPad.STANDARD`, `CordPad.remap`, `CordPad.validMapping`; `GET/PUT pad`.
- Produces: `openController()`.

Lista de controles (`navigator.getGamepads()`; "Reconhecido" quando `mapping === "standard"`); "Mapear" percorre `STANDARD` + analógicos (esquerdo direita/baixo, direito direita/baixo) um por vez sobre o SVG do controle (desenho próprio, `art.svg#pad`), detectando a primeira mudança (botão > 0.5, eixo > 0.6 longe do repouso medido no começo, hat pelo valor discreto); "Pular"; teste ao vivo com `remap`; "Salvar" → `PUT pad`. Sem `getGamepads` ou com erro: *"O Discord não liberou o controle nesta janela"* + "Abrir no navegador" (mesmo `postMessage` da Task 10, com o caminho da home).

- [ ] **Step 1:** Implementar.
- [ ] **Step 2: Verificar no navegador interno** com um controle falso (`javascript_tool` sobrescrevendo `navigator.getGamepads` com um adaptador de d-pad em hat): mapear tudo, salvar, recarregar e ver o mapa de volta; no BT3 servido, `navigator.getGamepads()[0].mapping === "standard"` com o mapa.
- [ ] **Step 3:** `bun test` → PASS.
- [ ] **Step 4: Commit** — `"Home: mapear o controle de PS2"`.

---

### Task 16: Home — intro e "Entrar como jogador 2"

**Files:**
- Create: `page/home/intro.js`
- Modify: `page/index.html`, `page/home/drawer.js`, `page/home/library.js`

**Interfaces:**
- Consumes: `POST played`, `intro.mp4`, `open` de cada jogo no `GET games`.
- Produces: `play(game, { join?: string })`.

`play`: `POST played`; overlay em tela cheia com `<video src="intro.mp4" autoplay playsinline>` (com som); clique, qualquer tecla, `ended` ou `error` → navega para `bt3/game/` ou `ps2/<id>/game/` (com `?join=<código>` quando for entrar numa sala); `prefers-reduced-motion` → sem fade. Destaque e gaveta mostram as salas livres: "Fulano está jogando — Entrar como jogador 2"; ocupadas: "Cheia".

- [ ] **Step 1:** Implementar.
- [ ] **Step 2: Verificar no navegador interno:** com `data/intro.mp4` (a versão em 1080p feita na conversa) a intro toca e pula com clique e tecla; sem o arquivo, vai direto; uma sala criada por `POST ps2/<id>/game/room` aparece na gaveta e o clique abre `?join=`.
- [ ] **Step 3: Commit** — `"Home: intro do PS2 e entrar como jogador 2"`.

---

### Task 16b: Volume e filtro de TV de tubo nos jogos (pedido no meio da execução)

**Files:**
- Create: `page/overlay.ts` (bundle `overlay.js`), `page/volume.ts` (a parte testável), `page/volume.test.ts`
- Modify: `server/people.ts` (+ `prefs`), `server/routes.ts` (rota `prefs`, injeção do `overlay.js`), `server/index.ts`, testes de `people` e rotas

**Interfaces:**
- `server/people.ts`: `interface Prefs { volume: number /* 0–1 */; filter: "off" | "crt" | "scan" }`, `DEFAULT_PREFS = { volume: 0.7, filter: "off" }`, `prefs(user): Promise<Prefs>`, `setPrefs(user, p: unknown): Promise<boolean>`; arquivo `prefs/<id>.json`.
- Rota `GET/PUT prefs` sob `/p/<passe>/`.
- `page/volume.ts`: `installVolume(api: { AudioNode, AudioDestinationNode, HTMLMediaElement? }, volume: number) → { set(v: number): void }` — todo `connect(destination)` passa por um `GainNode` por contexto; `disconnect(destination)` desfaz no ganho; elementos `<audio>/<video>` recebem `volume`.
- `overlay.js` (injetado depois do `pad.js` em todo jogo: BT3, PS2 e `play/`): botão discreto no canto superior direito (opaco só no hover/foco), painel com slider de volume (0–100, mudo), filtro (Desligado / TV de tubo / Scanlines leves); filtro como camada `pointer-events: none` (scanlines, máscara RGB, vinheta) mais `filter` leve no canvas; preferências lidas e salvas em `../prefs` (debounce 500 ms); teclas dentro do painel não chegam ao jogo; foco volta ao canvas.

- [ ] Testes: `people` (prefs padrão, ida e volta, inválido recusado), rotas (`prefs`, `overlay.js` injetado nos três tipos de página), `volume.test.ts` (com nós falsos: um ganho por contexto, `set` muda o ganho, `disconnect(destination)`).
- [ ] Implementar; verificar no navegador interno (botão, painel, filtro visível, preferências voltam ao recarregar).
- [ ] Commit — `"Jogos: volume e filtro de TV de tubo"`.

---

### Task 17: Verificação final

- [ ] **Step 1:** `bun test` (todos) e `bun run typecheck` → verdes; anotar o número de testes.
- [ ] **Step 2:** Compilar de verdade, se houver Docker e uma ISO de teste do dono: `docker compose up --build ps2-builder app` com a ISO enviada pela home; acompanhar os passos até `ready` ou `failed` com motivo; abrir o jogo no navegador interno (fora do Discord) e ver o shell carregar com isolation (`crossOriginIsolated === true`).
- [ ] **Step 3:** BT3 continua igual: home mostra "Pronto", "Jogar" toca a intro e abre o jogo.
- [ ] **Step 4:** Relatório para o dono com o que não deu para verificar aqui (Discord desktop: isolation, controle, WebRTC; compilação real se não houve ISO).
- [ ] **Step 5:** Pedir revisão do branch inteiro (superpowers:requesting-code-review) antes de abrir PR.
