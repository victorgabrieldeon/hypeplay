# Biblioteca de PS2: qualquer ISO vira um jogo da central — design

> **Atualização (2026-10-30):** o motor dos jogos de PS2 passou a ser o TabStationToo (PCSX2 em WebAssembly), sem
> compilação por jogo: ver [`2026-10-30-motor-tabstationtoo-design.md`](2026-10-30-motor-tabstationtoo-design.md). O
> que aqui fala do ps2-web-recomp, do `ps2-builder` e da compilação vale só como histórico.

Data: 2026-10-30. Branch: `feat/biblioteca-ps2`. Visual: [`DESIGN.md`](../../../DESIGN.md).

## Objetivo

Hoje o CordPlay só sabe compilar um jogo, o Budokai Tenkaichi 3, com um compilador feito para ele. Esta
feature abre a central para **qualquer jogo de PS2**: alguém envia a ISO (e, se quiser, a capa), o servidor
compila o jogo **uma vez só** com o [ps2-web-recomp](https://github.com/snuri00/ps2-web-recomp) e o jogo fica
na biblioteca para todo mundo jogar depois, pela atividade do Discord. Junto vêm:

- **online para jogos com segundo jogador**: quem joga abre a sala e um amigo entra como jogador 2, de dentro
  do Discord;
- saves no servidor, um memory card por pessoa;
- mapeamento do controle de PS2, para quando o navegador não reconhece o controle;
- a intro do PS2 ao abrir um jogo;
- um redesign da home (roxo, capas em pé, assistente de envio com o aviso de compatibilidade).

## Decisões tomadas

| Pergunta | Decisão |
| --- | --- |
| Para quem vale a biblioteca | **Uma só para todo o CordPlay** (como o BT3 hoje): um jogo compilado vale em todos os servidores do Discord do app. |
| Saves | **No servidor, um por pessoa** (memory card por usuário do Discord e por jogo). |
| Quem edita um jogo (capa, nome, recompilar, remover) | **Qualquer pessoa** que abre a atividade. |
| Sem isolation dentro do Discord | O jogo tenta no Discord; se não isolar, mostra **"Abrir no navegador"**. |
| BT3 | Continua com o builder e o online dele (**abordagem A**: builder genérico novo ao lado). |
| Controle | Sempre um controle de PS2. Funciona sozinho quando o navegador reconhece; se não reconhecer, a pessoa mapeia uma vez. |
| Intro | Toca toda vez que alguém abre um jogo (BT3 incluso), pode ser pulada, com som. |
| Online (PS2) | O do próprio ps2-web-recomp (o host transmite, o convidado é o jogador 2), com as salas listadas na home. O BT3 segue com o Dragon Net Battle. |

## Premissas e limites

- **Compatibilidade:** o ps2-web-recomp só levou dois jogos do começo ao fim (Gran Turismo 4 e God of War II).
  Qualquer ISO **compila**, mas a maioria deve parar numa syscall, numa função do IOP ou num recurso do GS
  ainda não implementado. A interface diz isso antes do envio e mostra até onde o jogo chegou nos testes do
  builder.
- **Isolation:** o runtime usa threads (`-pthread`, `SharedArrayBuffer`, worker da VU1, áudio em memória
  compartilhada) e se recusa a rodar sem `crossOriginIsolated`. O BT3 rodar liso no Discord **não prova** que
  isso funciona: o CordPlay não manda cabeçalho de isolation hoje, então o port do BT3 roda sem threads. A
  isolation dentro do Discord depende do `Document-Isolation-Policy` (Chrome 137+) no Chromium do app do
  Discord; por isso existe o "Abrir no navegador".
- **Navegador:** WebGPU, JSPI, SIMD, tail calls, exceções do wasm. Chrome e Edge; Discord desktop depende da
  versão do Chromium dele; Discord mobile, provavelmente não.
- **Direitos:** como hoje, a ISO, o C++ gerado, o wasm e as capturas são do dono do jogo: só no volume do
  servidor, nunca no git nem em imagem. A intro (`intro.mp4`, a animação de boot do PS2) também é material da
  Sony: fica no volume, nunca no git. O ps2-web-recomp é MIT.
- **Recursos:** ~300 MB por jogo compilado (mais a ISO), compilação estimada entre 10 e 30 min com 2 CPUs e
  renderizador por software nas rodadas de teste (o autor mede 3,5 min com 8 núcleos). Uma vez por jogo.

## Arquitetura

```
Discord (iframe)                     servidor (Dokploy, docker-compose.yml)
┌─────────────────────────┐          ┌──────────────────────────────────────────────┐
│ entry.html (SDK)        │  /token  │ app (Bun, server/)                           │
│  └ home  p/<passe>/     ├─────────►│  passe, catálogo, envio, capa, saves, mapa   │
│     └ jogo BT3  (opaca) │          │  do controle, intro, jogos (BT3 e PS2)       │
│     └ jogo PS2 (isolado)│          │            │ volume bt3-data → /app/data/    │
│ navegador (fallback)    │          │ builder      (BT3, como hoje)  → bt3/        │
│  └ jogo PS2 COOP/COEP   │          │ ps2-builder  (novo, ps2-web-recomp) → ps2/   │
└─────────────────────────┘          └──────────────────────────────────────────────┘
```

### Volume (`/app/data/`)

```
bt3/                         (como hoje)
ps2/<id>/                    um jogo da biblioteca; <id> = serial normalizado (slus-21678)
  game.json                  { id, serial, name, by: {id, name}, at, cover: bool }   escrito pelo app
  cover.webp                 a capa, normalizada pelo app (600×900)
  upload/, disc.iso          como no BT3 (server/upload.ts, sem mudanças)
  retry                      "Tentar de novo" (o app escreve, o ps2-builder apaga)
  status.json                escrito só pelo ps2-builder (com o sinal de vida)
  build/                     publicado pelo ps2-builder, troca atômica
  build.log
ps2-work/<id>/               intermediários do port.sh (games/<id>, generated/<id>, build/*-<id>)
saves/<id>/<discordId>.ps2   memory cards; fora de ps2/<id>/ para sobreviver a "Remover"
pads/<discordId>.json        mapas de controle da pessoa, por modelo de controle
users/<discordId>.json       { last: "<chave do jogo>", at }  (o destaque da home)
intro.mp4                    opcional, colocado à mão pelo dono do servidor
```

### `app` (server/)

Módulos novos, pequenos e testáveis como os de hoje:

- **`iso9660.ts`** — lê o `SYSTEM.CNF` de um disco: descritor primário no setor 16, diretório raiz, arquivo
  `SYSTEM.CNF`, linha `BOOT2 = cdrom0:\SLUS_216.78;1`. Devolve `{ serial: "SLUS-21678", id: "slus-21678",
  boot }` ou `null`. Funciona sobre uma função `read(offset, length)`, para usar com arquivo no servidor e com
  `File.slice` no navegador. O servidor empacota esse mesmo arquivo para a página ao subir (`Bun.build`, como
  já faz com `entry.ts`), em `/p/<passe>/iso.js`: uma fonte só.
- **`library.ts`** — o catálogo: o BT3 de `games.ts` mais os `ps2/*/game.json`. Cria um jogo novo (pasta +
  `game.json`), edita nome e capa, remove (apaga `ps2/<id>/` e `ps2-work/<id>/`, **mantém** `saves/<id>/`),
  recompila (apaga `build/` e escreve `retry`). Cada jogo de PS2 usa um `createDiscStore` próprio em
  `ps2/<id>/`, com 100 MiB a 9 GiB de limite (há jogos de PS2 em CD).
- **`saves.ts`** — memory card por pessoa: só aceita 8.650.752 bytes começando com
  `Sony PS2 Memory Card Format `; grava em `.tmp` e renomeia. A pessoa só lê e grava o próprio (id do passe).
- **`pads.ts`** — mapas de controle por pessoa: `{ [gamepadId]: Mapping }`, validados (formato e limites).
- **`cover.ts`** — a capa: PNG, JPG ou WebP até 5 MB, convertida para WebP 600×900 (recorte 2:3 ao centro)
  com `sharp`; sem capa, um SVG gerado a partir do serial (formas geométricas e o degradê da marca, sempre
  igual para o mesmo jogo, sem marca nenhuma de terceiros).
- **`routes.ts`** ganha as rotas abaixo; as do BT3 não mudam (salvo a injeção do `pad.js`).

Rotas novas (todas sob `/p/<passe>/`, como hoje; sem passe válido, 403):

| Rota | O que faz |
| --- | --- |
| `GET games` | Agora com os jogos de PS2: `{ key, kind: "port"\|"recomp", id, name, serial, cover, status, rooms, by }`; e `me` + `last`. |
| `POST ps2` `{ serial, name }` | Reserva um jogo novo. 409 `{ exists: key }` se o serial já está na biblioteca (o do BT3, `SLUS-21678`, aponta para o BT3). |
| `GET/PUT ps2/<id>/upload`, `GET ps2/<id>/status`, `POST ps2/<id>/retry` | Como os do BT3. Ao completar, o app lê o `SYSTEM.CNF` da ISO inteira; serial diferente do reservado (ou nenhum) → apaga a ISO e o jogo, `failed` "Isso não parece um disco de PS2" / "A ISO não é do jogo escolhido". |
| `PATCH ps2/<id>` `{ name }`, `PUT ps2/<id>/cover`, `DELETE ps2/<id>/cover` | Editar nome e capa. |
| `POST ps2/<id>/rebuild`, `DELETE ps2/<id>` | Recompilar, remover. |
| `GET cover/<key>` | A capa (WebP enviada ou SVG gerado), `Cache-Control` com versão na URL. |
| `GET/PUT ps2/<id>/save` | O memory card da pessoa. GET 404 quando ainda não há. |
| `GET/PUT pad` | Os mapas de controle da pessoa. |
| `POST played` `{ key }` | Marca o último jogo da pessoa (o destaque da home). |
| `GET intro.mp4` | `data/intro.mp4` com Range; 404 sem o arquivo. |
| `GET pad.js`, `GET iso.js`, `GET fonts/*` | Scripts da página e as fontes (de `@fontsource-variable/*`, servidas daqui). |
| `GET ps2/<id>/game/` e `game/<arquivo>` | O jogo, da lista fixa: `index.html` (o `ps2web.html` publicado), `ps2web.js`, `ps2web.wasm`, `ps2web.data` (o `.gz` quando o navegador aceita), `shots/NN.png`. |
| `GET ps2/<id>/game/disc.iso` | A ISO com **Range** (206, `Content-Range`, `Accept-Ranges`); HEAD também (o shell mede o disco assim). |
| `POST ps2/<id>/game/room`, `POST ps2/<id>/game/room/<código>/<para>`, `GET ps2/<id>/game/room/<código>/<eu>?after=N` | A sinalização do online (ver Online). |
| `GET ps2/<id>/game/ice` | Os servidores ICE para o WebRTC: STUN sempre, e TURN com credencial temporária quando configurado. |

**Cabeçalhos das rotas `ps2/<id>/game/*`:** sem o CSP `sandbox` (uma origem opaca provavelmente impede a
isolation); com `Content-Security-Policy: frame-ancestors …` (só o Discord emoldura), `Document-Isolation-Policy:
isolate-and-require-corp`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy:
require-corp` e `Cross-Origin-Resource-Policy: same-origin`. O resto do site continua com os cabeçalhos de hoje.

**Injeção do `pad.js`:** ao servir o `index.html` de qualquer jogo (BT3 e PS2), o app insere
`<script src="…/pad.js"></script>` antes de `</head>` (caminho relativo ao jogo). Se não achar `</head>`,
serve o jogo sem o script e registra o motivo. Assim o BT3 já compilado ganha o mapeamento sem recompilar.

**`PUBLIC_URL`** (variável nova, opcional): o endereço público do app (`https://bt3.exemplo.com`), para o
"Abrir no navegador" (dentro do Discord a página está no proxy `*.discordsays.com`). Sem ela, o botão não
aparece.

### `ps2-builder` (novo, `ps2-builder/`)

- **Imagem:** base Debian com clang, cmake, ninja, python3, 7z, git e Bun; o ps2-web-recomp clonado no commit
  fixo `e026b971324068773eed88bf502437de9e581b6b` (`ARG`, como o BT3 faz com o fork dele); `scripts/setup.sh`
  rodado no build da imagem (instala o emsdk 6.0.11, baixa o wgpu-native, compila `eerecomp` e `vurecomp`).
  Sem SDL: o `ps2run` das rodadas de teste roda sem janela e cai no renderizador por software quando não há
  GPU. **Nada de jogo na imagem.**
- **Patch do shell** (`ps2-builder/patch.ts`, no molde do `builder/patch.ts`, falha alto se um trecho
  esperado sumir), aplicado ao `web/shell.html` da cópia do código antes de qualquer compilação:
  1. **Saves no servidor:** troca a montagem do IDBFS em `/memcard` por um `GET ../save` (grava o card em
     MEMFS se existir) e o `FS.syncfs` do `storeCard` por um `PUT ../save` com o card inteiro (debounce de
     300 ms que já existe). "Export/Import card" continuam.
  2. **Abrir no navegador:** quando `missingFeatures()` só acusa a isolation, em vez do erro mostra o botão;
     o clique faz `parent.postMessage({ t: "cordplay:open", url }, "*")` com a URL do jogo em `PUBLIC_URL`.
     Os outros requisitos (WebGPU, JSPI…) mostram a mensagem do shell, em português.
  3. **Online** (ver Online): o botão Invite vira "Abrir sala" / "Sala ABC234", sem copiar link; o
     `rtcConfig` fixo vira o que `GET ice` devolver (com o fixo de hoje como reserva se a chamada falhar);
     textos do convidado em português.
  4. **Quick save** e preferências seguem usando o armazenamento do navegador quando ele existe (na aba do
     navegador funciona; no Discord, falha em silêncio, como o próprio shell já trata com `try`).
- **Laço** (`ps2-builder/builder.ts`, Bun, mesmo padrão do `builder/builder.ts`): a cada 5 s, sinal de vida
  no `status.json` de cada jogo; escolhe **o jogo mais antigo** com `disc.iso` e sem `build/` (ou com `retry`)
  e compila **um por vez**; os outros ficam `queued`. Roda `scripts/port.sh <id> <disc.iso>` com
  `games/`, `generated/` e `build/` do repositório apontando para `ps2-work/<id>/`, e acompanha a saída:
  cada `== [n/6] …` vira o passo `n` com o nome em português (Lendo o disco, Executável, Traduzindo para C++,
  Explorando o jogo, Unidades vetoriais, Compilando a página). Rodadas de teste e quadros por rodada vêm de
  `PS2_ROUNDS` (padrão 4) e `PS2_FRAMES` (padrão 3600).
- **Publicar:** copia `ps2web.{html,js,wasm,data}` (+ `.gz`) e as últimas 6 capturas de
  `games/<id>/shots/` (como `shots/01.png`…) para `build.tmp/`, e troca por `build/` de uma vez.
- **Falha:** `failed` com as últimas linhas do log; quando acha `[sys] unhandled syscall` ou
  `[iop] missing <lib> #<n>` no log, essa linha vira o motivo em destaque. Sem espaço em disco → "Sem espaço
  no servidor" e `ps2-work/<id>/` apagada. Jogo removido no meio da compilação → para e segue para o próximo.
- **Compose:** serviço `ps2-builder`, mesmo volume, `cpus: "2"`, `restart: unless-stopped`.

### Online dos jogos de PS2

O ps2-web-recomp já traz o online pronto no shell: **quem hospeda** roda o jogo e transmite o vídeo e o som
do canvas por WebRTC; **o convidado** abre a mesma página com `?join=<código>`, não baixa jogo nem disco e
manda o controle dele por um canal de dados, que vira o **jogador 2** do console. Vale para qualquer jogo que
aceite um segundo controle (o próprio jogo decide o que o jogador 2 faz). O convidado **não precisa de
isolation, WebGPU nem JSPI** (o shell pula essas checagens com `?join=`), então joga de dentro do Discord
mesmo quando o host precisou abrir no navegador.

- **Sinalização** (`server/ps2rooms.ts`, port do `/room` do `scripts/serve.py`, em memória): `POST room` cria
  uma sala com código de 6 letras (`A–Z` e `2–9`, sem as ambíguas) e guarda quem criou (nome do passe) e o
  jogo; `POST room/<código>/<para>` põe uma mensagem JSON (até 64 KB) na caixa de alguém; `GET
  room/<código>/<eu>?after=N` espera até 20 s por mensagens novas (long-poll). Sala sem uso por 1 h some. As
  mensagens são a oferta, a resposta e os candidatos do WebRTC, repassados como vêm. Lógica numa classe com
  relógio injetável, testável sem rede, como o `rooms.ts` do BT3.
- **Salas na home:** `GET games` traz, por jogo, as salas abertas `{ código, host, desde, ocupada }`. A gaveta
  do jogo e o destaque mostram **"Fulano está jogando — Entrar como jogador 2"**; o clique toca a intro e
  abre `ps2/<id>/game/?join=<código>`. Sala com convidado aparece como "Cheia".
- **Host:** dentro do jogo, "Abrir sala" cria a sala e mostra o código; o resto (aceitar o convidado, soltar o
  jogador 2 quando ele sai ou some por 3 s) é do próprio shell.
- **ICE / TURN:** `GET ice` devolve STUN (os públicos que o shell já usa) e, se as variáveis `TURN_URL` e
  `TURN_SECRET` existirem, um TURN com credencial temporária no padrão REST do coturn (usuário
  `<expiração>:<id do Discord>`, senha HMAC-SHA1 com o segredo, válida por 12 h). Sem TURN, redes que não
  se alcançam direto não conectam; o compose ganha um serviço `turn` (coturn) opcional, comentado, com o que
  precisa abrir no firewall.
- **BT3:** sem mudança; continua com o Dragon Net Battle (`rooms.ts`).

### Página de entrada (`page/entry.ts`)

Ganha um ouvinte de `message`: `{ t: "cordplay:open", url }` vindo do iframe do jogo, com `url` começando em
`PUBLIC_URL` → `sdk.commands.openExternalLink({ url })`. Qualquer outra coisa é ignorada.

### Controle (`page/pad.ts` → `pad.js`, e a tela de mapeamento na home)

- **Mapping:** para cada um dos 16 botões do layout standard e os 4 eixos, uma origem: `{ button: i }`,
  `{ axis: i, dir: 1|-1 }` (eixo usado como botão, com limiar 0,5), `{ hat: i, value: v }` (direcional num
  eixo só, com valores discretos, comum em adaptador de PS2) ou `{ axis: i, invert?: true }` (para os eixos).
- **`pad.js` nos jogos:** substitui `navigator.getGamepads()`. Para um controle com mapa (pelo `gamepad.id`),
  devolve um objeto com `mapping: "standard"`, `buttons` e `axes` traduzidos, e o `vibrationActuator` do
  controle real. Sem mapa, devolve o controle como veio. Carrega os mapas com `GET ../pad` (relativo) ao abrir.
- **Tela "Controle" na home:** lista os controles conectados; para cada um, "Mapear" percorre ✕ ○ □ △ L1 R1
  L2 R2 L3 R3 Start Select, direcional (4 direções), analógico esquerdo (direita, baixo) e direito (direita,
  baixo), um por vez, sobre um desenho em SVG de um controle de PS2 (desenho próprio, sem marca). Cada passo
  aceita botão, eixo ou hat; dá para pular; no fim, teste ao vivo (o botão acende no desenho) e "Salvar" →
  `PUT pad`. Controle com `mapping === "standard"` aparece como "Reconhecido" (mapear é opcional).
- **Discord sem controle:** se `navigator.getGamepads` não existir ou lançar erro dentro do Discord, a tela
  diz "O Discord não liberou o controle nesta janela" e oferece "Abrir no navegador".

### Home (`page/index.html`, refeita)

Segue o [`DESIGN.md`](../../../DESIGN.md). Uma página estática como hoje, sem framework; os scripts maiores
(`iso.js`, `pad.js`) vêm empacotados pelo servidor.

- **Lateral:** Biblioteca, Adicionar jogo, Controle.
- **Destaque:** o último jogo da pessoa (`last`), ou o primeiro pronto; capa desfocada ao fundo, "Jogar".
- **Biblioteca:** grade de capas 2:3 com o estado por cima (Pronto, Experimental, Compilando 3/6, Na fila,
  Enviando 42%, Falhou, Compilador parado). BT3 leva o selo "Testado"; jogos de PS2, "Experimental".
- **Gaveta do jogo** (clique na capa): capa, nome, serial, quem enviou; editar nome e capa; o progresso do
  envio e da compilação (passos, tempo, velocidade, como hoje); as capturas dos testes ("até onde o servidor
  chegou no jogo"); o log da falha; "Jogar", "Tentar de novo", "Recompilar" e "Remover" (com confirmação:
  "Remove o jogo para todo mundo. Os saves ficam guardados").
- **Adicionar jogo** (assistente em 3 passos, num modal):
  1. **Aviso**, que só segue marcando "Entendi": *"Esse jogo vai ser compilado por um projeto experimental.
     Só 2 jogos foram testados do começo ao fim. O seu pode não abrir, travar, ficar com gráficos quebrados
     ou sem som. A compilação roda uma vez só e leva de 10 a 30 minutos. Use só a ISO de um jogo que você
     tem."*
  2. **ISO:** escolher ou arrastar; `iso.js` lê o serial no navegador. Sem `SYSTEM.CNF` → "Isso não parece um
     disco de PS2". Já na biblioteca → "Já está aqui" + "Jogar".
  3. **Nome e capa:** nome sugerido pelo serial (editável), capa opcional com prévia recortada em 2:3;
     "Enviar" → `POST ps2`, `PUT cover` (se houver) e o envio em pedaços de 32 MB de hoje.
- **Intro:** "Jogar" → `POST played`, overlay em tela cheia com `intro.mp4` (com som; o clique é o gesto),
  pulado por clique, tecla ou fim do vídeo, e então navega para o jogo. Sem intro (404 ou erro), navega direto.
- **Animações:** capa sobe com brilho no hover, gaveta e modal deslizam, passos da compilação com barra
  animada, fade na intro. Tudo desligado com `prefers-reduced-motion`.
- **Estreito** (< 760 px): uma coluna, lateral vira barra no topo, gaveta ocupa a tela.

### Volume e filtro nos jogos (pedido durante a implementação)

Em todo jogo (BT3, PS2 e homebrew) o servidor injeta o `overlay.js`, como o `pad.js`: um botão discreto no canto
abre um painel com **slider de volume** e **filtro** (Desligado, TV de tubo, Scanlines leves). O volume passa todo o
áudio WebAudio do jogo por um ganho (e ajusta `<audio>/<video>`); o filtro é uma camada por cima do jogo
(scanlines, máscara RGB, vinheta) e um ajuste leve de cor no canvas. As escolhas ficam no servidor por pessoa
(`prefs/<id>.json`), com volume padrão de 70%.

## Estados de um jogo de PS2

`empty` (reservado, sem envio) → `uploading` → `queued` → `building` (passos 1–6) → `ready`, ou `failed`
(`message`, `reason`). `offline` quando o `ps2-builder` não dá sinal há mais de 2 min. Um jogo `empty` sem
envio há mais de 24 h some da biblioteca (reserva abandonada).

## Erros

| Situação | O que acontece |
| --- | --- |
| ISO sem `SYSTEM.CNF` / BOOT2 | O assistente recusa antes do envio; o app confere de novo ao completar. |
| Jogo já na biblioteca | "Já está aqui" + "Jogar"; nada é enviado (409 no `POST ps2`). |
| ISO completa com outro serial | O app apaga a ISO e o jogo; "A ISO não é do jogo escolhido". |
| `port.sh` falha | `failed` com o fim do log e o motivo em destaque; "Tentar de novo". |
| Compila mas trava | Selo "Experimental" e as capturas dos testes na gaveta. |
| Sem isolation no Discord | "Abrir no navegador" (com `PUBLIC_URL`), senão a explicação. |
| Sem WebGPU/JSPI | A mensagem do shell, em português. |
| Controle bloqueado no Discord | Aviso na tela de controle + "Abrir no navegador". |
| Save inválido | 400; o anterior fica intacto. |
| Capa inválida ou > 5 MB | 400 com o motivo; o jogo segue sem capa. |
| Dois envios do mesmo jogo | O segundo vê "Fulano está enviando este jogo" (regra de hoje). |
| `ps2-builder` parado | `offline` no card. |
| Sala não existe mais / host saiu | O convidado vê "A sala ABC234 não existe mais" e volta para a home. |
| Sala cheia | "Cheia" na home; um segundo convidado não substitui o primeiro. |
| WebRTC não conecta (sem TURN) | Depois de 15 s: "Não deu para conectar com o host. Talvez a rede de um dos dois bloqueie; o servidor precisa de um TURN." |
| Disco cheio | `failed` "Sem espaço no servidor", intermediários apagados. |

## Testes

Automatizados (`bun test`, ao lado do código):

- `server/iso9660.test.ts` — lê `SYSTEM.CNF` de uma ISO falsa pequena (gerada no teste); `null` sem ele;
  serial normalizado.
- `server/library.test.ts` — catálogo BT3 + PS2; reservar, duplicado (409, inclusive o serial do BT3),
  renomear, remover mantendo saves, recompilar, reserva abandonada.
- `server/saves.test.ts`, `server/pads.test.ts`, `server/cover.test.ts` — validação, um por pessoa, troca
  atômica; capa convertida e recortada, SVG gerado estável.
- `server/routes.test.ts` (ampliado) — Range e HEAD no `disc.iso`; cabeçalhos de isolation só em
  `ps2/*/game/`; lista fixa e `.gz`; injeção do `pad.js` (e jogo servido sem ele quando falta `</head>`);
  ISO completa com serial diferente; intro com Range.
- `ps2-builder/builder.test.ts` — `port.sh` falso: passos a partir da saída, fila de um por vez, falha com
  motivo, retry, publicação atômica com as capturas, jogo removido no meio.
- `server/ps2rooms.test.ts` — criar sala (código válido, sem repetir), mensagem chega na caixa certa, long-poll
  acorda com mensagem nova e expira em 20 s, sala ociosa some, limite de 64 KB, sala listada por jogo com o
  host e "ocupada".
- `server/ice.test.ts` — só STUN sem as variáveis; TURN com usuário e senha no padrão do coturn, expiração.
- `ps2-builder/patch.test.ts` — trechos reais do `web/shell.html` do commit fixo (em `fixtures/`): saves no
  servidor, botão "Abrir no navegador", "Abrir sala" e o `rtcConfig` vindo de `ice`; falha alto se um trecho
  sumir.
- `page/pad.test.ts` — botão, eixo e hat; eixos invertidos; sem mapa passa direto; layout standard.

Suíte inteira e `bun run typecheck` antes de cada commit.

Manuais (navegador interno, depois o Discord — o dono valida):

- Enviar uma ISO real com capa, compilar no Docker local, jogar.
- Save persiste entre sessões e entre PCs.
- Mapear um controle não reconhecido; o mapa vale no BT3 e no jogo de PS2.
- Intro toca, com som, e pula.
- Online: um abre a sala num jogo de 2 jogadores, outro entra pela home dentro do Discord, controla o jogador 2,
  sai e o host continua.
- Dentro do Discord: o jogo de PS2 isola ou mostra "Abrir no navegador", que abre a aba e joga.
- BT3 continua igual (online incluso).

## Fora deste trabalho

- Mais de 2 jogadores (multitap) e espectadores no online dos jogos de PS2.
- Bibliotecas por servidor do Discord ou por pessoa.
- Upscaler de IA para a intro (a versão em 1080p já foi feita com filtros clássicos).
- Patches do PCSX2 (`--pnach`) pela interface.

## Riscos

- **Isolation no Discord** — o maior: se o Chromium do Discord não aceitar o `Document-Isolation-Policy`,
  jogos de PS2 só rodam pelo "Abrir no navegador".
- **WebRTC dentro do Discord** — a atividade roda atrás do proxy do Discord; o vídeo do host e o STUN/TURN
  saem direto entre os navegadores. Se o Discord bloquear isso, o convidado só joga pelo navegador; precisa
  ser testado no app.
- **Qualidade do online** — o convidado recebe o vídeo comprimido, com o atraso da rede somado; para jogo de
  luta é jogável na mesma cidade, sofre mais longe.
- **Compatibilidade** — a maioria dos jogos deve compilar e não chegar longe; a interface precisa deixar isso
  claro sem frustrar.
- **Recursos do servidor** — compilação longa com 2 CPUs e sem GPU; ~300 MB por jogo mais a ISO.
- **Projeto de terceiros num commit fixo** — atualizar o ps2-web-recomp exige rever o `patch.ts` (que falha
  alto).
