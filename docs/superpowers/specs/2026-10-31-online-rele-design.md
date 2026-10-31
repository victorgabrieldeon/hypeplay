# Online dos jogos de PS2: relé pelo servidor quando o P2P não conecta — design

Data: 2026-10-31. Branch: `feat/biblioteca-ps2`. Complementa
[`2026-10-30-motor-tabstationtoo-design.md`](2026-10-30-motor-tabstationtoo-design.md): o online (host abre a sala,
amigo entra como jogador 2) continua como lá; esta spec muda só **por onde passam a imagem, o som e o controle**.

## Por que

Hoje o host transmite o jogo por WebRTC direto para o convidado (`page/stream.ts` → `page/watch.ts`). Isso falha em
dois casos comuns:

- **as redes não se alcançam** (CGNAT de operadora, roteador fechado) e o servidor não tem TURN. Foi o que
  aconteceu em 2026-10-30: o convidado chega até a última etapa e para em "Sem conexão com o host";
- **dentro do Discord não há WebRTC** (`RTCPeerConnection is not a constructor`), então o convidado (ou o host)
  que joga pela atividade nem começa.

Ligar o TURN resolve o primeiro caso, mas pede acesso ao Dokploy e ao firewall, e não resolve o segundo.

## Decisões tomadas

| Pergunta | Decisão |
| --- | --- |
| Relé sempre ou só quando precisa | **Plano B:** tenta o P2P primeiro; se não der, passa pelo servidor. |
| Quando cair para o relé | Na hora, quando um dos dois não tem WebRTC; senão, quando o P2P não conecta em **6 s** depois da oferta, ou falha antes disso. |
| Por onde passa o relé | WebSocket no próprio app (o mesmo que o Dragon Net Battle do BT3 já usa; o Traefik e o proxy do Discord deixam passar). Nada para configurar. |
| Vídeo | WebCodecs no host, 640×480, 60 fps, cerca de 2,5 Mbps; H.264 quando o host codifica e o convidado decodifica, senão VP8. Quadro-chave a cada 2 s e quando o convidado pede. |
| Som | Opus (WebCodecs `AudioEncoder`), 48 kHz estéreo, cerca de 96 kbps. |
| Controle | O mesmo JSON de hoje (`encodePad`, `page/guestpad.ts`), pelo WebSocket. |
| Quantos convidados | **Um, o jogador 2** (como hoje). Espectadores ficam para depois; o relé não os impede. |
| Convidado lento | O servidor descarta os quadros dele até o próximo quadro-chave, em vez de acumular atraso. |
| TURN | Continua opcional, como no #13: com ele, o P2P funciona em mais redes e o relé entra menos. |

## Como fica para quem usa

- **Nada muda quando o P2P funciona.**
- Quando não funciona, a tela do convidado diz "Conectando pelo servidor…" e, em cerca de 1 a 2 s, a imagem
  aparece. O atraso a mais é a ida e volta até o servidor (para quem está no Brasil com um servidor no Brasil, uns
  40 a 80 ms) e a codificação (cerca de 20 ms).
- **"Entrar como jogador 2" funciona dentro do Discord.** O "Onde jogar?" deixa de desligar "Aqui no Discord"
  para o convidado de um jogo de PS2 sem WebRTC (`page/home/intro.js`): ele vai direto pelo relé.
- Na barra do host, a sala diz por onde o jogador 2 está: "jogador 2 conectado" (P2P) ou "jogador 2 conectado
  pelo servidor".

## Como funciona

### O pedido do relé (pelas salas de hoje)

As mensagens de combinação continuam pelas caixas de entrada da sala (`server/ps2rooms.ts`, `room/<code>/<to>`).
Entram duas mensagens novas:

- `{type: "relay", from}`, do convidado para o host: "vamos pelo servidor". O convidado manda quando não tem
  WebRTC, quando o P2P não conecta em 6 s depois da oferta, ou quando ele falha antes disso.
- `{type: "relay-only"}`, do host para o convidado, em resposta ao `join`, quando o host não tem WebRTC (está no
  Discord). O convidado vai direto para o relé, sem esperar oferta.

Ao receber `relay`, o host fecha a conexão WebRTC daquele convidado (se houver) e abre o relé. O resto (o `join`, o
`full` para um segundo convidado, o `here` a cada 10 s que mantém a sala ocupada na biblioteca, o `bye`) não muda.

### O relé no servidor (`server/relay.ts`)

- **Endereço:** WebSocket em `p/<pass>/ps2/<id>/room/<code>/relay?role=host` e
  `…/relay?role=guest&me=<id do convidado>`, pelo mesmo `upgrade` do `NetData` de hoje (um terceiro `kind`,
  `"relay"`).
- **Quem pode:** o `host` só se o passe for o do dono da sala (`Ps2Rooms` sabe o `hostId`); o `guest` só se o `me`
  for um convidado que fez `join` naquela sala. Sala inexistente ou papel recusado: 403 antes do `upgrade`.
- **Um par por sala:** um host e um convidado. Um convidado com outro `me` é recusado (a sala já tem jogador 2);
  o mesmo `me` reconectando substitui a conexão anterior dele. Um segundo host substitui o anterior (é o mesmo
  dono reconectando).
- **Repasse por tipo de pacote** (o primeiro byte, abaixo): do host para o convidado só `CONFIG`, `VIDEO`, `AUDIO`
  e `BYE`; do convidado para o host só `HELLO`, `PAD`, `KEY` e `BYE`. Outro tipo, ou um pacote acima de 1 MB, é
  descartado.
- **Convidado lento:** se o que está esperando para ir ao convidado passa de 1 MB (`getBufferedAmount()`), o
  servidor descarta `VIDEO` e `AUDIO` dele e manda `KEY` ao host; volta a repassar no próximo `VIDEO` que é
  quadro-chave.
- **Fim:** o host fechar o relé manda `BYE` ao convidado e o fecha; o convidado fechar manda `BYE` ao host. A sala
  em si continua sendo das `Ps2Rooms` (fecha como hoje, quando o host sai do jogo).
- Nada fica gravado: o servidor só repassa, e nada além do buffer do próprio WebSocket fica na memória.

### Os pacotes (`page/relaywire.ts`, usado pelos dois lados e pelo servidor)

Mensagens binárias; o primeiro byte é o tipo:

| Tipo | Valor | Sentido | Conteúdo depois do tipo |
| --- | --- | --- | --- |
| `HELLO` | 1 | convidado → host | JSON: os codecs de vídeo e de som que o convidado decodifica |
| `CONFIG` | 2 | host → convidado | JSON: o codec, o tamanho e a `description` do vídeo; o codec, a taxa e os canais do som |
| `VIDEO` | 3 | host → convidado | 1 byte de flags (bit 0: quadro-chave), 4 bytes de tempo (ms, u32), o quadro codificado |
| `AUDIO` | 4 | host → convidado | 4 bytes de tempo (ms, u32), o pacote Opus |
| `PAD` | 5 | convidado → host | JSON do `encodePad` |
| `KEY` | 6 | convidado → host | nada: pede um quadro-chave (decodificador perdido, ou o servidor descartou quadros) |
| `BYE` | 7 | os dois | nada |

### O host (`page/stream.ts` e um módulo novo `page/relayhost.ts`)

- **Imagem:** o mesmo `canvas.captureStream(60)` do WebRTC, tocado num `<video>` escondido; a cada quadro novo
  (`requestVideoFrameCallback`) ele é desenhado num `OffscreenCanvas` de 640×480 e vira um `VideoFrame` para o
  `VideoEncoder` (`latencyMode: "realtime"`). Assim vale para o canvas do WebGPU e o do modo software, sem ler o
  canvas fora do quadro em que ele foi desenhado.
- **Codec:** entre os que o convidado disse no `HELLO`, o primeiro que `VideoEncoder.isConfigSupported` aceita:
  H.264 (`avc1.42E01F`, preferindo o da placa de vídeo), depois VP8.
- **Som:** o `tap()` do volume (`page/volume.ts`) entra num `AudioWorklet` que entrega blocos de PCM; eles viram
  `AudioData` para o `AudioEncoder` (Opus).
- **Controle:** o `PAD` vai para `cordplayGuest.set`, como o canal "pad" do WebRTC; o primeiro `HELLO` chama
  `cordplayGuest.join()`, e o `BYE` ou a queda do WebSocket chamam `leave()`.
- **Sem WebCodecs:** o host responde `{type: "relay-no"}` pela sala, e o convidado mostra "O navegador do host
  não consegue transmitir pelo servidor".

### O convidado (`page/watch.ts` e um módulo novo `page/relayguest.ts`)

- **A decisão** de passar para o relé fica numa função pura (`page/watchsteps.ts`): sem WebRTC → já; oferta
  recebida e 6 s sem conectar, ou conexão `failed` → relé; conectou → fica no P2P.
- **Imagem:** `VideoDecoder` desenhando num `canvas` no lugar do `<video>`. Um erro de decodificação pede `KEY` e
  espera o próximo quadro-chave.
- **Som:** `AudioDecoder` → um `AudioWorklet` com um pequeno buffer (alvo de 60 ms; acima de 200 ms acumulados, o
  excesso é descartado para não ir atrasando). O botão "Ligar o som" de hoje continua (política de autoplay).
- **Controle:** o mesmo `encodePad`, mandado quando muda e a cada 100 ms mesmo parado (que também mantém o
  WebSocket vivo).
- **Erros:** o WebSocket cair mostra "A conexão com o servidor caiu" com "Tentar de novo"; sem `VideoDecoder`,
  "Este navegador não consegue mostrar o jogo pelo servidor. Use um Chrome ou Edge atualizado."

## Critérios de pronto

- Com o P2P funcionando, nada muda (o relé não entra).
- Sem WebRTC num dos lados, ou com o P2P sem conectar, o convidado vê a imagem e ouve o som pelo relé, e o
  controle dele vira o jogador 2, em até cerca de 2 s depois da troca.
- Um convidado com internet lenta não vai acumulando atraso: perde quadros e volta no próximo quadro-chave.
- O atraso a mais do relé, medido em duas abas locais, fica abaixo de 150 ms.
- O convidado entra como jogador 2 de dentro do Discord.

## Testes

- **Unidade:**
  - os pacotes (montar e ler cada tipo, flags, tempo, tamanhos inválidos);
  - o relé do servidor com WebSockets de mentira: quem pode entrar, o sentido de cada tipo, o par por sala, o
    `BYE` dos dois lados, o descarte do convidado lento até o quadro-chave e o `KEY` ao host;
  - a escolha do codec;
  - a decisão de passar para o relé (sem WebRTC, 6 s, `failed`, conectado).
- **Rotas:** o `upgrade` recusado para quem não é o host da sala, para um convidado que não fez `join` e para
  sala inexistente.
- **No navegador:** host (BT3 pelo PCSX2) numa aba e convidado em outra, com `?relay=1` no convidado para forçar o
  relé (localmente o P2P funciona). Conferir a imagem, o som, o controle chegando ao host e o atraso
  (o tempo do quadro no host contra o tempo em que ele é desenhado no convidado, no mesmo relógio).

## Fora do escopo

- Espectadores (mais de um convidado só assistindo).
- Ajustar a qualidade sozinho conforme a internet (fica fixo em 2,5 Mbps; o descarte até o quadro-chave segura
  as conexões lentas).
- Tirar o TURN do compose.
