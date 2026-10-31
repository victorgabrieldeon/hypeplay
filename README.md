# HypePlay (atividade do Discord)

Uma central de jogos como atividade do Discord (o 🚀 do canal de voz): quem abre escolhe o jogo na biblioteca,
envia a ISO uma vez e o servidor compila o jogo para o navegador. Depois disso o jogo fica na biblioteca para todo
mundo, sem enviar nem compilar de novo. Há dois tipos de jogo:

- **Ports testados**, cada um com o próprio compilador (por enquanto, só o BT3, abaixo).
- **Qualquer jogo de PS2** (em teste): quem tiver a ISO adiciona o jogo, com capa se quiser. Ela fica guardada no
  servidor e roda direto no [TabStationToo](https://github.com/TabStationToo/TabStationToo), o PCSX2 compilado para
  WebAssembly, sem compilar nada (ver [Jogos de PS2](#jogos-de-ps2)).

O port testado de hoje:

- **Dragon Ball Z: Budokai Tenkaichi 3**, o port web do
[Tenkaichi3Decomp](https://github.com/stufno102/Tenkaichi3Decomp) (fork do stufno102, commit `81507cde`),
compilado no próprio servidor a partir da ISO do dono. Desenho original (da época em que era plugin do
HypeMeet): [`docs/2026-10-29-plugin-bt3-design.md`](docs/2026-10-29-plugin-bt3-design.md).

E uma prateleira de **homebrew**: cerca de 1600 jogos livres de Game Boy, Game Boy Color, GBA e NES do
[Homebrew Hub](https://hh.gbdev.io), prontos para jogar no [EmulatorJS](https://emulatorjs.org), sem ninguém
enviar nada. Cada jogo vem com a licença do autor (alguns não declaram nenhuma).

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
- **Homebrew:** a prateleira "Homebrew" da biblioteca, com busca (nome, autor, tag) e filtro por plataforma. Clicar
  numa capa abre o jogo no emulador; "Voltar" volta para a biblioteca. Teclado ou controle (o controle de PS2 mapeado em "Controle" vale aqui também); os controles do
  EmulatorJS ficam na barra de baixo. Saves e save states duram só a sessão (a mesma origem opaca).

## Jogos de PS2

- **BIOS, uma vez:** quem adiciona o primeiro jogo de PS2 envia também a BIOS do PS2 (o arquivo de 4 MB do próprio
  console, `.bin` ou `.ROM0`). Ela fica no servidor (`/app/data/bios/`) e nunca mais é pedida. A página e o servidor
  conferem que é uma BIOS de PS2 (4 MiB com a tabela ROMDIR).
- **ISO, uma vez por jogo:** "Adicionar jogo" na biblioteca. Antes do envio vem o aviso: o TabStationToo ainda está
  em teste, a maioria dos jogos roda e alguns podem travar ou ficar lentos. A página lê o serial da ISO
  (`SYSTEM.CNF`) antes de enviar: se o jogo já está na biblioteca, nada é enviado. O servidor confere o serial de
  novo com a ISO inteira e guarda a ISO.
- **Jogar:** assim que a ISO entra (e o servidor tem a BIOS), o jogo está pronto para todo mundo, para sempre. A
  página do jogo é a do TabStationToo no nosso design: só o jogo na tela, a nossa barra e o painel de som e imagem.
  "Remover" tira o jogo para todo mundo (os saves ficam guardados).
- **Capa e nome:** qualquer um pode trocar. Capa PNG, JPG ou WebP até 5 MB, guardada em WebP 600×900; sem capa, o
  servidor desenha uma a partir do serial.
- **Saves:** o memory card de cada pessoa fica no servidor (por jogo e por usuário do Discord), então vale em
  qualquer computador.
- **Controle:** sempre um controle de PS2. Se o navegador não reconhecer (adaptador USB genérico), "Controle" na
  biblioteca mapeia os botões uma vez; o mapa fica no servidor e vale em todos os jogos, BT3 incluso.
- **Intro:** ao abrir um jogo de PS2 (o BT3 incluso; homebrew não) toca a intro, se o servidor tiver uma (enviada uma vez pela tela **Servidor** da home, que também troca a BIOS; fica em `/app/data/intro.mp4`); clique ou
  tecla pula. Não vai para o git: é material da Sony.
- **Online:** dentro do jogo, "Abrir sala"; na biblioteca os amigos veem "Fulano está jogando — Entrar como
  jogador 2". O host transmite o jogo por WebRTC e o controle do convidado vira o jogador 2 (vale para jogos que
  aceitam um segundo controle). O convidado não precisa de nada além do navegador.
  Quando o WebRTC não conecta em 6 s (redes que não se alcançam direto, como internet de operadora com CGNAT), ou
  não existe (dentro do Discord), a imagem, o som e o controle passam **pelo próprio servidor**, pelo WebSocket do
  app, sem nada para configurar: um pouco mais de atraso (a ida e volta até o servidor) e cerca de 3 Mbps de banda
  do servidor por sala ([spec](docs/superpowers/specs/2026-10-31-online-rele-design.md)). Com um TURN
  ([Ligar o TURN](#ligar-o-turn)), mais conexões ficam diretas e o servidor repassa menos.
- **Isolamento e navegador:** o runtime usa threads, então a página do jogo é servida *cross-origin isolated*
  (`Document-Isolation-Policy`, COOP/COEP), sem o sandbox das outras páginas. Se o Discord não isolar a janela, o
  jogo mostra "Abrir no navegador" (precisa de `PUBLIC_URL`). Precisa de WebGPU e JSPI: Chrome ou Edge atualizado.
- **Versão rápida (opcional, por jogo):** jogos pesados podem ficar lentos no emulador (o God of War roda a ~8 fps
  nele, o VU1 no limite). Na gaveta do jogo, **Compilar a versão rápida** faz o serviço `ps2-builder` compilar o jogo
  com o [ps2-web-recomp](https://github.com/snuri00/ps2-web-recomp) (MIT): o código do jogo vira C++ e depois
  WebAssembly, sem emulador de CPU. Leva uns 20 a 40 minutos no servidor (o God of War: 21 minutos com 2 CPUs, até
  1,2 GB de memória), uma vez para todo mundo, e só compila os jogos pedidos, um por vez. Pronto, aparece **Jogar a versão rápida** (o God of War vai a 60 fps). O memory card é o mesmo
  do emulador (mesmo arquivo, mesmas regras: nunca grava um cartão em branco por cima do save, e um save do emulador
  que ficou sem enviar sobe antes). Nem todo jogo funciona:
  se a compilação falhar, a gaveta diz por quê e o emulador continua ali. Se o jogo chegar num trecho de código que a
  compilação não achou, a página manda o endereço ao servidor, que tenta recompilar com ele (só a página, sem jogar
  de novo), e oferece continuar no emulador. O online fica no emulador (a versão rápida joga sozinha ou com dois controles no
  mesmo PC). No Linux o Firefox/Zen também roda, com `dom.webgpu.enabled` ligado em `about:config`.

## Configurar o app no Discord

Um app para o HypePlay (não o do HypeMeet; o nome que aparece no Discord é o do app), em https://discord.com/developers/applications:

1. **OAuth2**: copie o *Client ID* e o *Client Secret* (vão nas variáveis abaixo). Em **Redirects**
   adicione `https://127.0.0.1`: o Discord exige um redirect cadastrado, mesmo sem usar.
2. **Activities → Settings**: ative as atividades e marque as plataformas (Desktop, Web). A atividade só
   aparece nas plataformas marcadas.
3. **Activities → URL Mappings**: `/` → `bt3.exemplo.com` (o destino vai **sem** `https://`).
4. **Installation**: **Guild Install**, com o *Discord Provided Link* e só o escopo `applications.commands`.
   Adicione o app aos seus servidores.

## Deploy (Dokploy)

`docker-compose.yml` sobe três serviços que dividem o volume `bt3-data`:

| Serviço | Domínio | O que faz |
| --- | --- | --- |
| `app` | `bt3.exemplo.com` → 3003 | Entrada pelo Discord, página do jogo, arquivos do jogo, pedaços da ISO, envio, salas do online (WebSocket) |
| `builder` | — (só o volume) | Confere a ISO, extrai, compila, ajusta os caminhos (`builder/patch.ts`) e publica |
| `ps2-builder` | — (só o volume) | A versão rápida dos jogos de PS2 pedidos (`ps2-builder/`): `port.sh` do ps2-web-recomp, um jogo por vez, 2 CPUs. `PS2_ROUNDS` e `PS2_FRAMES` (opcionais) dizem quantas partidas de teste e de quantos quadros |

| Variável | Para quê |
| --- | --- |
| `DISCORD_CLIENT_ID` | *Client ID* do app |
| `DISCORD_CLIENT_SECRET` | *Client Secret* do app. Também assina os passes: trocar o segredo derruba quem está jogando. Nunca vai pro git |
| `PUBLIC_URL` | Recomendado. O endereço `https://` do app: "Abrir no navegador" (o Discord não roda os jogos de PS2 nem o vídeo do jogador 2 na janela dele) e **entrar pelo navegador** (botão "Entrar com o Discord" na página inicial). Para entrar pelo navegador, cadastre `<PUBLIC_URL>/auth` em OAuth2 → Redirects no Discord Developer Portal |
| `COMPOSE_PROFILES`, `TURN_URL`, `TURN_SECRET` | Opcionais. O TURN do online dos jogos de PS2, para redes que não se alcançam: veja [Ligar o TURN](#ligar-o-turn) |

Sem `DISCORD_CLIENT_ID` ou `DISCORD_CLIENT_SECRET` o servidor não sobe.

### Ligar o TURN

O vídeo do jogador 2 vai direto do navegador do host para o do convidado. Quando uma das redes não aceita conexão
de fora (CGNAT, roteador fechado), os dois só se falam por um retransmissor, o TURN. O compose já traz um
(coturn, serviço `turn`), desligado até ser pedido. No Dokploy:

1. Em **Environment**, acrescente:
   ```
   COMPOSE_PROFILES=turn
   TURN_SECRET=<uma senha longa e aleatória>
   TURN_URL=turn:<nome do servidor>:3478
   ```
   O `<nome do servidor>` precisa apontar **direto** para o IP da máquina. Se o domínio do app passa pelo proxy da
   Cloudflare (nuvem laranja), use o IP ou um subdomínio "DNS only". O app oferece o TURN por UDP e por TCP.
2. No firewall da máquina (e no painel do provedor, se ele tiver um), abra **3478/udp**, **3478/tcp** e
   **49160-49200/udp**.
3. Faça o deploy de novo. O `turn` sobe junto, e o app passa o TURN aos navegadores (credencial de 12 h assinada
   com o `TURN_SECRET`).

Em nuvens que põem a máquina atrás de NAT (AWS, Google Cloud, Oracle), o coturn também precisa de
`--external-ip=<IP público>/<IP privado>` no `command` do serviço `turn`.

O coturn só repassa para a internet: nunca para a própria máquina nem para redes privadas.

**Conferir:** se mesmo assim o jogador 2 não conectar, a tela dele diz se o TURN respondeu. "O TURN do servidor
não respondeu" quer dizer coturn parado ou portas fechadas.

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

Os jogos de PS2 ficam em `/app/data/ps2/<serial>/` (`game.json`, `cover.webp`, `disc.iso`, e `fast/` com a versão
rápida: o pedido, `status.json`, `build.log`, `misses.txt` e `build/`) e a BIOS em `/app/data/bios/`. O que a
compilação da versão rápida gera fica em `/app/data/ps2-work/<serial>/` (uns 300 MB por jogo). O que é de cada pessoa: `saves/<serial>/<id do Discord>.ps2` (memory cards), `pads/<id>.json` (mapas de
controle) e `users/<id>.json` (último jogo). A intro opcional é `/app/data/intro.mp4` (enviada pela tela Servidor).

**Refazer do zero:** pare o `builder` e apague `/app/data/bt3/` no volume. Um jogo de PS2: "Remover" na biblioteca;
só a versão rápida: "Apagar a versão rápida" na gaveta do jogo.

O homebrew fica em `/app/data/homebrew/`: `catalog.json` (a lista, buscada na API do Homebrew Hub ao subir
quando tem mais de um dia, e depois a cada dia) e, por jogo, o ROM e a capa, baixados do GitHub dos bancos
do Homebrew Hub na primeira vez que alguém pede. Apagar a pasta só faz baixar de novo. O EmulatorJS e os
cores vão na imagem (`emulator/fetch.ts`, versão fixa e conferida pelo hash do npm).

## Local

```sh
bun install
bun emulator/fetch.ts   # EmulatorJS e os cores em emulator/data/ (uma vez)
bun test
DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… bun run start   # porta 3003; guarda tudo em data/bt3/
```

O Discord só abre a atividade por HTTPS: exponha a porta 3003 num túnel (ex. `cloudflared tunnel --url
http://localhost:3003`) e ponha o domínio do túnel no URL mapping `/` de um app de teste. Para compilar,
suba o builder apontando para a mesma pasta:

```sh
docker build -t bt3-builder builder
docker run --rm -v "$PWD/data:/app/data" bt3-builder
```

Para abrir a biblioteca sem o Discord, gere um passe com o mesmo segredo e abra `http://localhost:3003/p/<passe>/`:

```sh
bun scripts/pass.ts "$DISCORD_CLIENT_SECRET" 42 Ana
```

## Por dentro

- `server/`: o catálogo (`games.ts`), a prateleira de homebrew (`homebrew.ts`), entrada pelo Discord (`discord.ts`), passe (`pass.ts`), rotas (`routes.ts`), envio da ISO
  (`upload.ts`), salas do online em memória (`rooms.ts`, port do `room.js` do fork). Para os jogos de PS2: a
  biblioteca (`library.ts`), o serial pelo `SYSTEM.CNF` (`iso9660.ts`), capas (`cover.ts`), saves (`saves.ts`),
  mapas de controle e último jogo (`people.ts`), salas e ICE do online (`ps2rooms.ts`, `ice.ts`) e as respostas com
  Range e isolamento (`http.ts`).
- `page/`: a entrada (`entry.html` e `entry.ts`, empacotado com o SDK do Discord quando o servidor sobe), a
  home (`index.html` e `home/`: biblioteca, homebrew, envio, progresso, controle, servidor, intro), o emulador do homebrew
  (`play.html`) e os scripts empacotados ao subir: `pad.js` (o controle mapeado dentro dos jogos e do emulador, de
  `pad.ts` e `padmap.ts`) e `iso.js` (o serial no navegador).
- `emulator/fetch.ts`: baixa o EmulatorJS e os cores (gambatte, mgba, fceumm) dos tarballs do npm. Não são
  dependências do `package.json` porque o pacote puxa as ferramentas de build e, opcional, todos os cores (300 MB).
- `builder/`: a imagem e o laço do compilador do BT3. O `patch.ts` troca os caminhos absolutos do jogo por
  relativos e falha alto se o fork mudar.
- `emulator/ps2-fetch.ts` e `ps2-files.json`: baixam o TabStationToo (GPL-3.0) e conferem cada arquivo por SHA-256;
  `--update` pega a versão publicada agora e regrava os hashes (depois revise `server/ps2page.ts`).
- `server/ps2page.ts` e `page/ps2play.ts`: a página do TabStationToo no nosso design (BIOS e disco do servidor,
  memory card do servidor no slot 1, o console dele escondido, a nossa barra e o rodapé da licença).

## Adicionar um port testado

Jogos de PS2 entram pela própria biblioteca (ver [Jogos de PS2](#jogos-de-ps2)). Um port com compilador próprio,
como o do BT3, entra assim:

1. Uma entrada em `server/games.ts`: o `id` vira a pasta no volume (`/app/data/<id>/`) e o caminho
   (`p/<passe>/<id>/`). Também vão a ISO aceita, os tamanhos, os passos e a lista fixa de arquivos servidos.
2. Um compilador próprio, no molde de `builder/`: lê `/app/data/<id>/disc.iso`, escreve `status.json`
   (com o heartbeat) e publica em `build/`. Vira mais um serviço no `docker-compose.yml`, no mesmo volume.
3. O port precisa usar só caminhos relativos (como o `patch.ts` faz no BT3). As salas do online
   (`rooms.ts`) seguem o protocolo do port do BT3: um jogo com outro protocolo precisa do próprio.
