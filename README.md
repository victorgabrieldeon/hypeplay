# Budokai Tenkaichi 3 (plugin do HypeMeet)

Dragon Ball Z: Budokai Tenkaichi 3 no navegador, com os amigos de uma sala do
[HypeMeet](https://github.com/victorgabrieldeon/hypemeet). Usa o port web do
[Tenkaichi3Decomp](https://github.com/stufno102/Tenkaichi3Decomp) (fork do stufno102, commit `81507cde`),
compilado no próprio servidor a partir da ISO do dono. Desenho completo:
[`docs/2026-10-29-plugin-bt3-design.md`](docs/2026-10-29-plugin-bt3-design.md).

> **Só para servidor privado.** O jogo é compilado a partir do jogo de verdade: use só com amigos que têm,
> cada um, a própria cópia do jogo. O acesso exige estar numa sala do HypeMeet, o que protege de quem não
> entra nas salas, não de quem entra. Não deixe o HypeMeet aberto ao público com este plugin na lista.

## Como usar

- **Primeira vez:** quem abrir o plugin envia a ISO (só a americana, SLUS-21678; uma vez para o servidor
  todo). O envio vai em pedaços de 32 MB e retoma se cair. O serviço `builder` confere a ISO, extrai os
  dados e compila o jogo (alguns minutos, 2 CPUs no máximo). Quem abrir o plugin no meio-tempo vê o passo
  atual. Depois disso, abrir o plugin carrega o jogo direto, com tudo desbloqueado.
- **Jogar:** online em "Dragon Net Battle" (criar sala dá um código de 4 letras; o outro entra com ele, ou
  Quick Match), ou local (contra a CPU, dois no mesmo PC). Clique no jogo para dar foco: as teclas vão para
  ele (F1 abre as configurações do jogo) e os atalhos da sala não disparam.
- **Isolamento:** a página e o jogo rodam sempre em origem opaca (sandbox no iframe e no cabeçalho CSP), sem
  `localStorage`. Por isso saves e configurações do jogo não ficam guardados entre sessões.

## Deploy (Dokploy)

`docker-compose.yml` sobe dois serviços que dividem o volume `bt3-data`:

| Serviço | Domínio | O que faz |
| --- | --- | --- |
| `app` | `bt3.exemplo.com` → 3003 | Página do plugin, arquivos do jogo, pedaços da ISO, envio, salas do online (WebSocket) |
| `builder` | — (só o volume) | Confere a ISO, extrai, compila, ajusta os caminhos (`builder/patch.ts`) e publica |

| Variável | Para quê |
| --- | --- |
| `HYPEMEET_URL` | O site do HypeMeet (ex. `https://meet.exemplo.com`): só ele pode emoldurar a página, e é ele quem confirma os passes |

No HypeMeet:

1. Ponha `https://bt3.exemplo.com` em `PLUGINS`.
2. Para a atividade do Discord: URL mapping `/plugins/bt3` → `bt3.exemplo.com` no portal do Discord.

## Acesso

O manifest (`/hypemeet-plugin.json`) pede `"pass": true`. A sala abre a página com `?pass=<passe>`, e o
servidor manda para `p/<passe>/`: tudo do plugin mora sob esse caminho, porque o iframe não manda cabeçalhos
e, no Discord, não tem cookie. Só o HypeMeet lê o passe: o servidor pergunta a ele uma vez
(`POST <HYPEMEET_URL>/api/plugins/pass`) e guarda a resposta até o passe vencer (12 h). Sem passe válido,
tudo responde 403. O manifest e o ícone são públicos.

## Arquivos

Tudo fica no volume, em `/app/data/bt3/`: `disc.iso`, `work/` com o que a compilação gera, `build/` com o
jogo e `build.log`. Nada disso vai para o git nem para imagem nenhuma (`data/` está no `.gitignore`). Só a
lista fixa de arquivos do jogo e os pedaços da ISO são servidos.

**Refazer do zero:** pare o `builder` e apague `/app/data/bt3/` no volume.

## Local

```sh
bun install
bun test
HYPEMEET_URL=http://localhost:5173 bun run start   # porta 3003; guarda tudo em data/bt3/
```

No HypeMeet, `PLUGINS=http://localhost:3003` no `.env`. Para compilar, suba o builder apontando para a
mesma pasta:

```sh
docker build -t bt3-builder builder
docker run --rm -v "$PWD/data:/app/data" bt3-builder
```

## Por dentro

- `server/`: passe (`pass.ts`), rotas (`routes.ts`), envio da ISO (`upload.ts`), salas do online em memória
  (`rooms.ts`, port do `room.js` do fork).
- `page/`: a página do plugin (envio, progresso, erros).
- `builder/`: a imagem e o laço do compilador. O `patch.ts` troca os caminhos absolutos do jogo por
  relativos e falha alto se o fork mudar.
