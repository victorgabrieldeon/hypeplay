# CordPlay (atividade do Discord)

Uma central de jogos como atividade do Discord (o 🚀 do canal de voz): quem abre escolhe o jogo na biblioteca,
envia a ISO uma vez e o servidor compila o jogo para o navegador. Depois disso o jogo fica na biblioteca para todo
mundo, sem enviar nem compilar de novo. Há dois tipos de jogo:

- **Ports testados**, cada um com o próprio compilador (por enquanto, só o BT3, abaixo).
- **Qualquer jogo de PS2** (experimental): quem tiver a ISO adiciona o jogo, com capa se quiser, e o serviço
  `ps2-builder` compila com o [ps2-web-recomp](https://github.com/snuri00/ps2-web-recomp) (ver
  [Jogos de PS2](#jogos-de-ps2)).

O port testado de hoje:

- **Dragon Ball Z: Budokai Tenkaichi 3**, o port web do
[Tenkaichi3Decomp](https://github.com/stufno102/Tenkaichi3Decomp) (fork do stufno102, commit `81507cde`),
compilado no próprio servidor a partir da ISO do dono. Desenho original (da época em que era plugin do
HypeMeet): [`docs/2026-10-29-plugin-bt3-design.md`](docs/2026-10-29-plugin-bt3-design.md).

> **Só para servidor privado.** O jogo é compilado a partir do jogo de verdade: use só com amigos que têm,
> cada um, a própria cópia do jogo. Qualquer pessoa que abrir a atividade no Discord joga: o que segura o
> acesso é o app não ser divulgado (deixe o *Public Bot* desligado e adicione o app só aos seus servidores).

## Como usar

- **Home:** o catálogo, com o estado de cada jogo (pronto, precisa da ISO, enviando, compilando). "Jogar
  agora" abre o jogo pronto. O painel do lado mostra o envio com porcentagem, velocidade e quanto falta
  (também para quem só está olhando o envio de outra pessoa) e os passos da compilação.
- **Primeira vez:** quem abrir a atividade escolhe o jogo e envia a ISO (só a americana, SLUS-21678; uma vez para o servidor
  todo). O envio vai em pedaços de 32 MB e retoma se cair, até de outra vez que abrir a atividade. O serviço
  `builder` confere a ISO, extrai os dados e compila o jogo (alguns minutos, 2 CPUs no máximo). Quem abrir a
  atividade no meio-tempo vê o passo atual. Depois disso, abrir a atividade carrega o jogo direto, com tudo
  desbloqueado.
- **Jogar:** online em "Dragon Net Battle" (criar sala dá um código de 4 letras; o outro entra com ele, ou
  Quick Match), ou local (contra a CPU, dois no mesmo PC). Clique no jogo para dar foco: as teclas vão para
  ele (F1 abre as configurações do jogo).
- **Isolamento:** o jogo roda sempre em origem opaca (sandbox no cabeçalho CSP), sem `localStorage`. Por isso
  saves e configurações do jogo não ficam guardados entre sessões.

## Jogos de PS2

- **Adicionar:** "Adicionar jogo" na biblioteca. Antes do envio vem o aviso: o ps2-web-recomp só levou dois jogos do
  começo ao fim (Gran Turismo 4 e God of War II), então o seu pode não abrir, travar, ficar com gráficos quebrados
  ou sem som. A página lê o serial da ISO (`SYSTEM.CNF`) antes de enviar: se o jogo já está na biblioteca, nada é
  enviado. O servidor confere o serial de novo com a ISO inteira.
- **Compilar:** o `ps2-builder` roda o `scripts/port.sh` do ps2-web-recomp, um jogo por vez, uma vez por jogo (de
  10 a 30 minutos com 2 CPUs, estimado). As capturas das rodadas de teste aparecem no jogo ("até onde o servidor
  chegou"). "Recompilar" refaz; "Remover" tira o jogo para todo mundo (os saves ficam guardados).
- **Capa e nome:** qualquer um pode trocar. Capa PNG, JPG ou WebP até 5 MB, guardada em WebP 600×900; sem capa, o
  servidor desenha uma a partir do serial.
- **Saves:** o memory card de cada pessoa fica no servidor (por jogo e por usuário do Discord), então vale em
  qualquer computador.
- **Controle:** sempre um controle de PS2. Se o navegador não reconhecer (adaptador USB genérico), "Controle" na
  biblioteca mapeia os botões uma vez; o mapa fica no servidor e vale em todos os jogos, BT3 incluso.
- **Intro:** ao abrir qualquer jogo toca `intro.mp4` do volume (`/app/data/intro.mp4`), se existir; clique ou
  tecla pula. Não vai para o git: é material da Sony.
- **Online:** dentro do jogo, "Abrir sala"; na biblioteca os amigos veem "Fulano está jogando — Entrar como
  jogador 2". O host transmite o jogo por WebRTC e o controle do convidado vira o jogador 2 (vale para jogos que
  aceitam um segundo controle). O convidado não precisa de nada além do navegador. Redes que não se alcançam
  direto precisam de um TURN (`TURN_URL`, `TURN_SECRET`; o compose tem um coturn comentado).
- **Isolamento e navegador:** o runtime usa threads, então a página do jogo é servida *cross-origin isolated*
  (`Document-Isolation-Policy`, COOP/COEP), sem o sandbox das outras páginas. Se o Discord não isolar a janela, o
  jogo mostra "Abrir no navegador" (precisa de `PUBLIC_URL`). Precisa de WebGPU e JSPI: Chrome ou Edge atualizado.

## Configurar o app no Discord

Um app para o CordPlay (não o do HypeMeet; o nome que aparece no Discord é o do app), em https://discord.com/developers/applications:

1. **OAuth2**: copie o *Client ID* e o *Client Secret* (vão nas variáveis abaixo). Em **Redirects**
   adicione `https://127.0.0.1`: o Discord exige um redirect cadastrado, mesmo sem usar.
2. **Activities → Settings**: ative as atividades e marque as plataformas (Desktop, Web). A atividade só
   aparece nas plataformas marcadas.
3. **Activities → URL Mappings**: `/` → `bt3.exemplo.com` (o destino vai **sem** `https://`).
4. **Installation**: **Guild Install**, com o *Discord Provided Link* e só o escopo `applications.commands`.
   Adicione o app aos seus servidores.

## Deploy (Dokploy)

`docker-compose.yml` sobe dois serviços que dividem o volume `bt3-data`:

| Serviço | Domínio | O que faz |
| --- | --- | --- |
| `app` | `bt3.exemplo.com` → 3003 | Entrada pelo Discord, página do jogo, arquivos do jogo, pedaços da ISO, envio, salas do online (WebSocket) |
| `builder` | — (só o volume) | Confere a ISO, extrai, compila, ajusta os caminhos (`builder/patch.ts`) e publica |
| `ps2-builder` | — (só o volume) | Compila os jogos de PS2 da biblioteca com o ps2-web-recomp (`ps2-builder/`), um por vez |

| Variável | Para quê |
| --- | --- |
| `DISCORD_CLIENT_ID` | *Client ID* do app |
| `DISCORD_CLIENT_SECRET` | *Client Secret* do app. Também assina os passes: trocar o segredo derruba quem está jogando. Nunca vai pro git |
| `PUBLIC_URL` | Opcional. O endereço `https://` do app, para "Abrir no navegador" quando o Discord não roda um jogo de PS2 na janela dele |
| `TURN_URL`, `TURN_SECRET` | Opcionais. Um TURN (coturn com `--use-auth-secret`) para o online dos jogos de PS2 entre redes que não se alcançam |
| `PS2_ROUNDS`, `PS2_FRAMES` | Opcionais (`ps2-builder`). Rodadas de teste por jogo (padrão 4) e quadros por rodada (padrão 3600) |

Sem `DISCORD_CLIENT_ID` ou `DISCORD_CLIENT_SECRET` o servidor não sobe.

## Acesso

A atividade abre em `/`: a página de entrada pede ao Discord um código (`authorize`, escopo `identify`) e o
troca em `POST /token`. O servidor troca o código pelo usuário do Discord e devolve um passe assinado aqui
mesmo (HMAC, 12 h): sem passar pelo Discord, não há passe. A entrada então abre a home num iframe em
`p/<passe>/`, e cada jogo em `p/<passe>/<id>/` (estado, envio, `game/`). Tudo mora sob esse caminho, porque o iframe não manda cabeçalhos e, no Discord, não tem
cookie. Sem passe válido, tudo ali responde 403. A entrada e o ícone são públicos; só o Discord pode
emoldurar as páginas.

## Arquivos

Tudo fica no volume, em `/app/data/bt3/`: `disc.iso`, `work/` com o que a compilação gera, `build/` com o
jogo e `build.log`. Nada disso vai para o git nem para imagem nenhuma (`data/` está no `.gitignore`). Só a
lista fixa de arquivos do jogo e os pedaços da ISO são servidos.

Os jogos de PS2 ficam em `/app/data/ps2/<serial>/` (`game.json`, `cover.webp`, `disc.iso`, `build/`,
`status.json`, `build.log`) e os intermediários da compilação em `/app/data/ps2-work/<serial>/` (uns 300 MB por
jogo). O que é de cada pessoa: `saves/<serial>/<id do Discord>.ps2` (memory cards), `pads/<id>.json` (mapas de
controle) e `users/<id>.json` (último jogo). A intro opcional é `/app/data/intro.mp4`.

**Refazer do zero:** pare o `builder` e apague `/app/data/bt3/` no volume. Um jogo de PS2: "Recompilar" na
biblioteca, ou pare o `ps2-builder` e apague `ps2-work/<serial>/` e `ps2/<serial>/build/`.

## Local

```sh
bun install
bun test
DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… bun run start   # porta 3003; guarda tudo em data/bt3/
```

O Discord só abre a atividade por HTTPS: exponha a porta 3003 num túnel (ex. `cloudflared tunnel --url
http://localhost:3003`) e ponha o domínio do túnel no URL mapping `/` de um app de teste. Para compilar,
suba o builder apontando para a mesma pasta:

```sh
docker build -t bt3-builder builder
docker run --rm -v "$PWD/data:/app/data" bt3-builder
docker build -t ps2-builder -f ps2-builder/Dockerfile .
docker run --rm -v "$PWD/data:/app/data" ps2-builder
```

Para abrir a biblioteca sem o Discord, gere um passe com o mesmo segredo e abra `http://localhost:3003/p/<passe>/`:

```sh
bun scripts/pass.ts "$DISCORD_CLIENT_SECRET" 42 Ana
```

## Por dentro

- `server/`: o catálogo (`games.ts`), entrada pelo Discord (`discord.ts`), passe (`pass.ts`), rotas (`routes.ts`), envio da ISO
  (`upload.ts`), salas do online em memória (`rooms.ts`, port do `room.js` do fork). Para os jogos de PS2: a
  biblioteca (`library.ts`), o serial pelo `SYSTEM.CNF` (`iso9660.ts`), capas (`cover.ts`), saves (`saves.ts`),
  mapas de controle e último jogo (`people.ts`), salas e ICE do online (`ps2rooms.ts`, `ice.ts`) e as respostas com
  Range e isolamento (`http.ts`).
- `page/`: a entrada (`entry.html` e `entry.ts`, empacotado com o SDK do Discord quando o servidor sobe), a
  home (`index.html` e `home/`: biblioteca, envio, progresso, controle, intro) e os scripts empacotados ao subir:
  `pad.js` (o controle mapeado dentro dos jogos, de `pad.ts` e `padmap.ts`) e `iso.js` (o serial no navegador).
- `builder/`: a imagem e o laço do compilador do BT3. O `patch.ts` troca os caminhos absolutos do jogo por
  relativos e falha alto se o fork mudar.
- `ps2-builder/`: a imagem e o laço do compilador dos jogos de PS2 (o `port.sh` do ps2-web-recomp num commit fixo).
  O `patch.ts` ajusta a página do ps2-web-recomp (saves no servidor, salas, "Abrir no navegador") e falha alto se
  ela mudar.

## Adicionar um port testado

Jogos de PS2 entram pela própria biblioteca (ver [Jogos de PS2](#jogos-de-ps2)). Um port com compilador próprio,
como o do BT3, entra assim:

1. Uma entrada em `server/games.ts`: o `id` vira a pasta no volume (`/app/data/<id>/`) e o caminho
   (`p/<passe>/<id>/`). Também vão a ISO aceita, os tamanhos, os passos e a lista fixa de arquivos servidos.
2. Um compilador próprio, no molde de `builder/`: lê `/app/data/<id>/disc.iso`, escreve `status.json`
   (com o heartbeat) e publica em `build/`. Vira mais um serviço no `docker-compose.yml`, no mesmo volume.
3. O port precisa usar só caminhos relativos (como o `patch.ts` faz no BT3). As salas do online
   (`rooms.ts`) seguem o protocolo do port do BT3: um jogo com outro protocolo precisa do próprio.
