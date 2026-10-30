# CordPlay (atividade do Discord)

Uma central de jogos como atividade do Discord (o 🚀 do canal de voz): quem abre escolhe o jogo no catálogo,
envia a ISO uma vez e o servidor compila o jogo para o navegador. Cada jogo é um port web de uma decompilação,
com o próprio compilador (serviço `builder`). Por enquanto o catálogo tem um jogo:

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

- **Homebrew:** a seção abaixo do catálogo, com busca (nome, autor, tag) e filtro por plataforma. Clicar
  numa capa abre o jogo no emulador; "Voltar" volta para a home. Teclado ou controle; os controles do
  EmulatorJS ficam na barra de baixo. Saves e save states duram só a sessão (a mesma origem opaca).

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

| Variável | Para quê |
| --- | --- |
| `DISCORD_CLIENT_ID` | *Client ID* do app |
| `DISCORD_CLIENT_SECRET` | *Client Secret* do app. Também assina os passes: trocar o segredo derruba quem está jogando. Nunca vai pro git |

Sem qualquer uma das duas o servidor não sobe.

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

**Refazer do zero:** pare o `builder` e apague `/app/data/bt3/` no volume.

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

## Por dentro

- `server/`: o catálogo (`games.ts`), a prateleira de homebrew (`homebrew.ts`), entrada pelo Discord (`discord.ts`), passe (`pass.ts`), rotas (`routes.ts`), envio da ISO
  (`upload.ts`), salas do online em memória (`rooms.ts`, port do `room.js` do fork).
- `page/`: a entrada (`entry.html` e `entry.ts`, empacotado com o SDK do Discord quando o servidor sobe) e a
  home (`index.html`: catálogo, homebrew, envio, progresso, erros) e o emulador do homebrew (`play.html`).
- `emulator/fetch.ts`: baixa o EmulatorJS e os cores (gambatte, mgba, fceumm) dos tarballs do npm. Não são
  dependências do `package.json` porque o pacote puxa as ferramentas de build e, opcional, todos os cores (300 MB).
- `builder/`: a imagem e o laço do compilador do BT3. O `patch.ts` troca os caminhos absolutos do jogo por
  relativos e falha alto se o fork mudar.

## Adicionar um jogo

1. Uma entrada em `server/games.ts`: o `id` vira a pasta no volume (`/app/data/<id>/`) e o caminho
   (`p/<passe>/<id>/`). Também vão a ISO aceita, os tamanhos, os passos e a lista fixa de arquivos servidos.
2. Um compilador próprio, no molde de `builder/`: lê `/app/data/<id>/disc.iso`, escreve `status.json`
   (com o heartbeat) e publica em `build/`. Vira mais um serviço no `docker-compose.yml`, no mesmo volume.
3. O port precisa usar só caminhos relativos (como o `patch.ts` faz no BT3). As salas do online
   (`rooms.ts`) seguem o protocolo do port do BT3: um jogo com outro protocolo precisa do próprio.
