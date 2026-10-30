# Budokai Tenkaichi 3 (atividade do Discord)

Dragon Ball Z: Budokai Tenkaichi 3 como atividade do Discord (o 🚀 do canal de voz). Usa o port web do
[Tenkaichi3Decomp](https://github.com/stufno102/Tenkaichi3Decomp) (fork do stufno102, commit `81507cde`),
compilado no próprio servidor a partir da ISO do dono. Desenho original (da época em que era plugin do
HypeMeet): [`docs/2026-10-29-plugin-bt3-design.md`](docs/2026-10-29-plugin-bt3-design.md).

> **Só para servidor privado.** O jogo é compilado a partir do jogo de verdade: use só com amigos que têm,
> cada um, a própria cópia do jogo. Só joga quem é membro de um dos servidores do Discord em
> `DISCORD_GUILDS`, o que protege de quem está fora deles, não de quem está dentro.

## Como usar

- **Primeira vez:** quem abrir a atividade envia a ISO (só a americana, SLUS-21678; uma vez para o servidor
  todo). O envio vai em pedaços de 32 MB e retoma se cair, até de outra vez que abrir a atividade. O serviço
  `builder` confere a ISO, extrai os dados e compila o jogo (alguns minutos, 2 CPUs no máximo). Quem abrir a
  atividade no meio-tempo vê o passo atual. Depois disso, abrir a atividade carrega o jogo direto, com tudo
  desbloqueado.
- **Jogar:** online em "Dragon Net Battle" (criar sala dá um código de 4 letras; o outro entra com ele, ou
  Quick Match), ou local (contra a CPU, dois no mesmo PC). Clique no jogo para dar foco: as teclas vão para
  ele (F1 abre as configurações do jogo).
- **Isolamento:** o jogo roda sempre em origem opaca (sandbox no cabeçalho CSP), sem `localStorage`. Por isso
  saves e configurações do jogo não ficam guardados entre sessões.

## Configurar o app no Discord

Um app só para o jogo (não o do HypeMeet), em https://discord.com/developers/applications:

1. **OAuth2**: copie o *Client ID* e o *Client Secret* (vão nas variáveis abaixo). Em **Redirects**
   adicione `https://127.0.0.1`: o Discord exige um redirect cadastrado, mesmo sem usar.
2. **Activities → Settings**: ative as atividades e marque as plataformas (Desktop, Web). A atividade só
   aparece nas plataformas marcadas.
3. **Activities → URL Mappings**: `/` → `bt3.exemplo.com` (o destino vai **sem** `https://`).
4. **Installation**: **Guild Install**, com o *Discord Provided Link* e só o escopo `applications.commands`.
   Adicione o app aos servidores de `DISCORD_GUILDS`.

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
| `DISCORD_GUILDS` | IDs dos servidores do Discord cujos membros podem jogar, separados por vírgula (botão direito no servidor → *Copiar ID*, com o modo desenvolvedor ligado) |

Sem qualquer uma delas o servidor não sobe.

## Acesso

A atividade abre em `/`: a página de entrada pede ao Discord um código (`authorize`, escopos `identify` e
`guilds.members.read`) e o troca em `POST /token`. O servidor troca o código pelo token do Discord, confere
se a pessoa é membro de um servidor de `DISCORD_GUILDS` (nunca o servidor que a página diz, sempre o
Discord) e devolve um passe assinado aqui mesmo (HMAC, 12 h). A entrada então abre o jogo num iframe em
`p/<passe>/`: tudo do jogo mora sob esse caminho, porque o iframe não manda cabeçalhos e, no Discord, não tem
cookie. Sem passe válido, tudo ali responde 403. A entrada e o ícone são públicos; só o Discord pode
emoldurar as páginas.

## Arquivos

Tudo fica no volume, em `/app/data/bt3/`: `disc.iso`, `work/` com o que a compilação gera, `build/` com o
jogo e `build.log`. Nada disso vai para o git nem para imagem nenhuma (`data/` está no `.gitignore`). Só a
lista fixa de arquivos do jogo e os pedaços da ISO são servidos.

**Refazer do zero:** pare o `builder` e apague `/app/data/bt3/` no volume.

## Local

```sh
bun install
bun test
DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… DISCORD_GUILDS=… bun run start   # porta 3003; guarda tudo em data/bt3/
```

O Discord só abre a atividade por HTTPS: exponha a porta 3003 num túnel (ex. `cloudflared tunnel --url
http://localhost:3003`) e ponha o domínio do túnel no URL mapping `/` de um app de teste. Para compilar,
suba o builder apontando para a mesma pasta:

```sh
docker build -t bt3-builder builder
docker run --rm -v "$PWD/data:/app/data" bt3-builder
```

## Por dentro

- `server/`: entrada pelo Discord (`discord.ts`), passe (`pass.ts`), rotas (`routes.ts`), envio da ISO
  (`upload.ts`), salas do online em memória (`rooms.ts`, port do `room.js` do fork).
- `page/`: a entrada (`entry.html` e `entry.ts`, empacotado com o SDK do Discord quando o servidor sobe) e a
  página do jogo (`index.html`: envio, progresso, erros).
- `builder/`: a imagem e o laço do compilador. O `patch.ts` troca os caminhos absolutos do jogo por
  relativos e falha alto se o fork mudar.
