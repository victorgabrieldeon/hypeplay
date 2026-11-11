# HypePlay (atividade do Discord)

Uma central de jogos de PS2 como atividade do Discord (o 🚀 do canal de voz): quem tiver a ISO adiciona o jogo na
biblioteca, com capa se quiser. Ela fica guardada no servidor e roda direto no
[TabStationToo](https://github.com/TabStationToo/TabStationToo), o PCSX2 compilado para WebAssembly, sem compilar
nada (ver [Jogos de PS2](#jogos-de-ps2)). Depois disso o jogo fica na biblioteca para todo mundo.

> **Só para servidor privado.** Use só com amigos que têm, cada um, a própria cópia do jogo. Qualquer pessoa que
> abrir a atividade no Discord joga: o que segura o acesso é o app não ser divulgado (deixe o *Public Bot*
> desligado e adicione o app só aos seus servidores).

## Jogos de PS2

- **BIOS, uma vez:** quem adiciona o primeiro jogo de PS2 envia também a BIOS do PS2 (o arquivo de 4 MB do próprio
  console, `.bin` ou `.ROM0`). Ela fica no servidor (`/app/data/bios/`) e nunca mais é pedida. A página e o servidor
  conferem que é uma BIOS de PS2 (4 MiB com a tabela ROMDIR).
- **ISO, uma vez por jogo:** "Adicionar jogo" na biblioteca. Antes do envio vem o aviso: o TabStationToo ainda está
  em teste, a maioria dos jogos roda e alguns podem travar ou ficar lentos. A página lê o serial da ISO
  (`SYSTEM.CNF`) antes de enviar: se o jogo já está na biblioteca, nada é enviado. O servidor confere o serial de
  novo com a ISO inteira e guarda a ISO. Antes do primeiro pedaço ele confere se a ISO inteira cabe no disco
  deixando livre o maior entre 2 GB e 5% do disco (o Postgres e a fila moram nele); se não cabe, o envio nem começa
  (507, e a home mostra o aviso). Um envio parado há mais de 24 horas (desde o último pedaço) é apagado com a reserva.
- **Ou baixar do vimm.net, sem passar pelo PC:** na **Loja**, abra um jogo com **Instalação direta** e clique em
  **Instalar no servidor**. Também dá para colar a página (`https://vimm.net/vault/7843`) no campo de link da Loja ou no passo da ISO de
  "Adicionar jogo". O servidor consulta um catálogo público de metadados para encontrar o `mediaId` dessa edição,
  baixa sozinho (um jogo por vez, com progresso), abre o `.7z` (o `7z` vem na imagem), lê o serial e põe o jogo na biblioteca.
  Não precisa abrir o Vimm nem executar código no console para as edições mapeadas. Use apenas jogos que você tem.
  A fonte é o [catálogo PS2GD](https://github.com/forbenaj/ps2gd/tree/728c7d5ce988280310a9b593e961584fbd1bd8d1/data/catalogs),
  uma versão fixa de terceiros, consultada no GitHub e mantida em memória até reiniciar o servidor; não é uma API oficial
  nem cobre todas as regiões e versões. O ID da página e o `mediaId` são diferentes: não calculamos um a partir do outro.
  Se a edição não estiver mapeada, o GitHub estiver indisponível ou o link estiver desatualizado, ainda dá para colar o
  link de download (`https://dl2.vimm.net/?mediaId=…`) ou enviar sua ISO. Para obter o link manual: abra a página,
  passe pela verificação de humano, clique em Download, cancele e copie o endereço na lista de downloads do navegador.
  O servidor não tenta resolver essa verificação. Só jogos em ISO (os de CD, em `.bin/.cue`, não). O servidor precisa de
  espaço para o arquivo e a ISO ao mesmo tempo (em `/app/data/vimm/`, apagados no fim): ele confere antes de baixar
  (o dobro do tamanho do arquivo, com a mesma margem do envio) e de novo antes de extrair, e sem espaço a instalação
  falha com o aviso.
- **Jogar:** assim que a ISO entra (e o servidor tem a BIOS), o jogo está pronto para todo mundo, para sempre. A
  página do jogo é a do TabStationToo no nosso design: só o jogo na tela, a nossa barra e o painel de som e imagem.
  "Remover" tira o jogo para todo mundo (os saves ficam guardados).
- **Capa e nome:** qualquer um pode trocar. Capa PNG, JPG ou WebP até 5 MB, guardada em WebP 600×900; sem capa, o
  servidor desenha uma a partir do serial.
- **Saves:** o memory card de cada pessoa fica no servidor (por jogo e por usuário do Discord), então vale em
  qualquer computador.
- **Controle:** sempre um controle de PS2. Se o navegador não reconhecer (adaptador USB genérico), "Controle" na
  biblioteca mapeia os botões uma vez; o mapa fica no servidor e vale em todos os jogos.
- **Teclado:** sem mapa, valem as teclas de cada jogo. Em "Controle" → Teclado → Mapear, escolha uma tecla para cada botão
  e para cada direção dos dois analógicos (Pular deixa sem tecla). O mapa fica no servidor e vale no emulador e na
  versão rápida, como jogador 1 junto com o primeiro controle; as teclas mapeadas deixam de ir para o jogo, as outras
  continuam com o que o jogo faz com elas. Esc e Tab não podem ser mapeadas.
- **Intro:** ao abrir um jogo de PS2 toca a intro, se o servidor tiver uma (enviada uma vez pela tela **Servidor** da home, que também troca a BIOS; fica em `/app/data/intro.mp4`); clique ou
  tecla pula. Não vai para o git: é material da Sony.
- **Online:** dentro do jogo, "Abrir sala"; na biblioteca os amigos veem "Fulano está jogando — Entrar como
  jogador 2". O host transmite o jogo por WebRTC e o controle do convidado vira o jogador 2 (vale para jogos que
  aceitam um segundo controle). O convidado não precisa de nada além do navegador.
  Quando o WebRTC não conecta em 6 s (redes que não se alcançam direto, como internet de operadora com CGNAT), ou
  não existe (dentro do Discord), a imagem, o som e o controle passam **pelo próprio servidor**, pelo WebSocket do
  app, sem nada para configurar: um pouco mais de atraso (a ida e volta até o servidor) e cerca de 3 Mbps de banda
  do servidor por sala. Com um TURN
  ([Ligar o TURN](#ligar-o-turn)), mais conexões ficam diretas e o servidor repassa menos.
- **Pessoas:** a seção "Pessoas" da biblioteca mostra quem mais está com o HypePlay aberto, primeiro quem está **na
  mesma call** (o canal de voz em que a atividade foi aberta; quem entrou pelo navegador aparece como online), e o que
  cada um tem aberto: a biblioteca, o jogo em que está, ou o jogo que está assistindo. Quem abriu uma sala num jogo de
  PS2 aparece com **Entrar** (como jogador 2, se a vaga estiver livre) e **Assistir**. Nada fica gravado: o servidor
  lembra quem está com a biblioteca aberta (enquanto a conexão dela estiver de pé) e quem falou com ele nos últimos
  40 s (a página do jogo a cada 15 s; a biblioteca fechada ainda conta por esses 40 s, para recarregar ou abrir um
  jogo não parecer saída).
- **Biblioteca ao vivo:** a home não pergunta mais ao servidor a cada 2 s. Ela abre uma conexão (`home/ws`) e o
  servidor manda só o que mudou: um jogo entrando ou saindo, o progresso de um envio ou da versão rápida, quem chegou
  ou saiu, pedidos de amizade e convites. O servidor olha a biblioteca uma vez para todo mundo (a cada 2 s enquanto
  alguém tem a home aberta, e logo depois de qualquer mudança), não uma vez por pessoa. Se a conexão cair (o proxy do
  Discord pode cortar), a home volta a perguntar a cada 2 s até ela voltar, e a resposta é `304` (vazia) quando nada
  mudou ([`server/homefeed.ts`](server/homefeed.ts)).
- **Assistir:** além do jogador 2, até 4 pessoas podem assistir a uma sala (na gaveta do jogo, em Pessoas, ou pelo
  "A sala está cheia" de quem chegou depois). Elas veem e ouvem o jogo, sem controle. Cada pessoa assistindo é mais
  uma transmissão saindo do PC do host (cerca de 2,5 Mbps de upload a mais), ou do servidor no relé.
- **Até 2 jogadores:** os dois motores de PS2 têm só as portas 1 e 2 (o TabStationToo fixa `NUM_PAD_PORTS = 2`,
  e o ps2-web-recomp lê só dois controles), sem multitap. Jogos de 3 ou 4 jogadores vão só até 2 por enquanto.
- **Isolamento e navegador:** o runtime usa threads, então a página do jogo é servida *cross-origin isolated*
  (`Document-Isolation-Policy`, COOP/COEP), sem o sandbox das outras páginas. Se o Discord não isolar a janela, o
  jogo mostra "Abrir no navegador" (precisa de `PUBLIC_URL`). Precisa de WebGPU e JSPI: Chrome ou Edge atualizado.
- **Versão rápida (opcional, por jogo):** jogos pesados podem ficar lentos no emulador (o God of War roda a ~8 fps
  nele, o VU1 no limite). Na gaveta do jogo, **Compilar a versão rápida** faz o serviço `ps2-builder` compilar o jogo
  com o [ps2-web-recomp](https://github.com/snuri00/ps2-web-recomp) (MIT): o código do jogo vira C++ e depois
  WebAssembly, sem emulador de CPU. Leva uns 20 a 40 minutos no servidor (o God of War: 21 minutos com 2 CPUs, até
  1,2 GB de memória), uma vez para todo mundo, e só compila os jogos pedidos, numa fila: um por vez em cada worker,
  primeiro quem parou num trecho sem código, depois os pedidos por ordem de chegada (mais workers, até em outras
  máquinas, compilam mais de uma vez: veja [Workers em outra máquina](#workers-em-outra-máquina)). Pronta, ela vira o padrão:
  **Jogar agora** e **Abrir uma sala** abrem a versão rápida (o God of War vai a 60 fps), e a gaveta guarda um **Jogar
  no emulador**. O online é o mesmo do emulador: "Abrir sala" no painel do jogo, o amigo entra pela biblioteca como
  jogador 2 (WebRTC, ou pelo servidor quando não conecta). O memory card também é o mesmo (mesmo arquivo, mesmas
  regras: nunca grava um cartão em branco por cima do save, e um save do emulador que ficou sem enviar sobe antes).
  Nem todo jogo funciona: se a compilação falhar, a gaveta diz por quê e o emulador continua ali. Se o jogo chegar
  num trecho de código que a compilação não achou, a página manda o endereço ao servidor, que tenta recompilar com ele
  (sem jogar de novo), e oferece continuar no emulador. Quando uma imagem nova do `ps2-builder` muda a página (o
  patch em `ps2-builder/patch.ts`) ou o ps2-web-recomp fixado, as versões prontas se atualizam sozinhas (só a página,
  se for só ela), e continuam jogáveis enquanto isso. No Linux o Firefox/Zen também roda, com `dom.webgpu.enabled`
  ligado em `about:config`.

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

`docker-compose.yml` sobe três serviços (mais o `turn`, opcional): `app` e `ps2-builder` dividem a pasta `/srv/bt3-data` do servidor (no disco do sistema: o segundo disco, `/mnt/disk`, é de rede e lento demais para os jogos), e o `postgres` guarda o banco no volume `postgres`:

| Serviço | Domínio | O que faz |
| --- | --- | --- |
| `app` | `bt3.exemplo.com` → 3003 | Entrada pelo Discord, a biblioteca, as páginas dos jogos, o envio da ISO, o online (WebSocket) |
| `postgres` | — (só a rede da stack, sem porta) | O banco (Postgres 17): o que é de cada pessoa e o social (`server/db.ts`). O `app` só sobe depois dele saudável |
| `ps2-builder` | — (só o volume) | A versão rápida dos jogos de PS2 pedidos (`ps2-builder/`): `port.sh` do ps2-web-recomp, um jogo por vez, 2 CPUs. Pega os jogos da fila de compilações (`/app/data/queue.db`). `PS2_ROUNDS` e `PS2_FRAMES` (opcionais) dizem quantas partidas de teste e de quantos quadros |

| Variável | Para quê |
| --- | --- |
| `DISCORD_CLIENT_ID` | *Client ID* do app |
| `DISCORD_CLIENT_SECRET` | *Client Secret* do app. Também assina os passes: trocar o segredo derruba quem está jogando. Nunca vai pro git |
| `POSTGRES_PASSWORD` | A senha do banco (o `app` monta o `DATABASE_URL` com ela). Só letras e números, porque vai dentro de uma URL: `openssl rand -hex 24`. Escolhida uma vez: o Postgres grava a senha ao criar o volume, e trocar aqui depois não troca lá |
| `PUBLIC_URL` | Recomendado. O endereço `https://` do app: "Abrir no navegador" (o Discord não roda os jogos de PS2 nem o vídeo do jogador 2 na janela dele) e **entrar pelo navegador** (botão "Entrar com o Discord" na página inicial). Para entrar pelo navegador, cadastre `<PUBLIC_URL>/auth` em OAuth2 → Redirects no Discord Developer Portal |
| `TURN_CF_KEY_ID`, `TURN_CF_TOKEN` | Recomendados. O TURN da Cloudflare para o online dos jogos de PS2, perto dos jogadores onde quer que estejam: veja [Ligar o TURN](#ligar-o-turn) |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Opcionais. Os discos novos e os saves no R2 (`server/discs.ts`, `server/saves.ts`); sem eles, tudo fica no disco do servidor |
| `DISC_CACHE_MB` | Opcional (com R2). Quantos MB de pedaços dos discos do R2 o app guarda na memória: veja [Cache](#cache-dos-discos-e-dos-arquivos). Padrão 256; `0` desliga |
| `DISC_EDGE_URL`, `DISC_EDGE_SECRET` | Opcionais (com R2), desligados. Os discos do emulador servidos por um Worker da Cloudflare perto dos jogadores: veja [Edge para os discos](#edge-para-os-discos-opcional) |
| `WORKER_TOKEN` | Opcional. Deixa workers da versão rápida em outras máquinas pegarem jogos da fila: veja [Workers em outra máquina](#workers-em-outra-máquina) |
| `BACKUP` | Opcional (com R2). O backup diário para o R2 vem ligado; `0` desliga: veja [Backup automático](#backup-automático) |

Sem `DISCORD_CLIENT_ID` ou `DISCORD_CLIENT_SECRET` o servidor não sobe. Sem `POSTGRES_PASSWORD` o Dokploy nem faz o
deploy (o compose recusa), e a versão que está no ar continua.

### Saúde, deploy e limites

- **Saúde:** `GET /health` é público e só responde `ok` (200), ou `draining` (503) enquanto o servidor desliga. É o
  `healthcheck` do `app` no compose; o Traefik só manda tráfego para um container saudável. O `ps2-builder` fica
  saudável enquanto o heartbeat dele (`/tmp/hypeplay-heartbeat` dentro do container, a cada 5 s, mesmo parados)
  tem menos de um minuto.
- **Deploy sem susto:** no SIGTERM o `app` para de aceitar conexões, fecha os WebSockets com o código 1012 (a página
  entende como "o servidor está reiniciando": o jogador 2 vê o aviso e a página abre de novo sozinha quando ele
  volta; a home e a loja reconectam sozinhas), espera até 10 s os pedidos em andamento, grava o que falta do social no banco e sai.
  As salas do online vivem na memória: uma partida em andamento pelo servidor termina no deploy, e o host abre a
  sala de novo.
- **Limites por pessoa** (pelo id do Discord do passe, em memória): 20 jogos adicionados e 20 envios de ISO por hora,
  10 downloads do vimm.net e 10 pedidos de versão rápida por hora, 30 convites a cada 10 min e 40 pedidos de amizade
  por hora (`server/limits.ts`). Passou disso, `429` com a mensagem que a home mostra ("Muitos … em pouco tempo.
  Tente de novo em N minutos."). Pedido recusado ou com erro não conta.

### Observabilidade

Os logs saem em JSON, uma linha por evento (`{"time","level","msg",…}`, `server/log.ts`). Com
`OTEL_EXPORTER_OTLP_ENDPOINT` definido, os dois serviços mandam métricas e o `app` manda também os logs por
OpenTelemetry (OTLP por HTTP, JSON: `server/otlp.ts`, sem dependências) para o SigNoz ou qualquer coletor. Sem ela,
nada sai e nada muda.

| Variável | Para quê |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Opcional. O endereço base do coletor OTLP/HTTP, ex. `http://signoz-otel-collector:4318` (o servidor junta `/v1/metrics` e `/v1/logs`). Vazia: nada sai |
| `OTEL_EXPORTER_OTLP_HEADERS` | Opcional. Cabeçalhos de cada envio, `chave=valor,chave2=valor2`. No SigNoz Cloud: `signoz-ingestion-key=<chave>` |
| `OTEL_RESOURCE_ATTRIBUTES` | Opcional. Mais sobre o serviço, ex. `deployment.environment=producao`. Os nomes dos serviços já vêm: `hypeplay` e `hypeplay-ps2-builder` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Opcional. De quanto em quanto tempo vão as métricas, em ms (60000) |
| `LOG_LEVEL` | Opcional. `debug`, `info` (padrão), `warn` ou `error` |

| Métrica | O que mede |
| --- | --- |
| `hypeplay.rooms.active` | Salas do online abertas |
| `hypeplay.people.online` | Pessoas com a home ou um jogo aberto |
| `hypeplay.websockets.open` | WebSockets abertos, por tipo (`home`, `relay`, `vimm`) |
| `hypeplay.disc.bytes` | Bytes de disco servidos, por jogo (`game`) e origem (`source`: `local` ou `r2`) |
| `hypeplay.games.duration` | Tempo da lista de jogos (`games`, a cada 2 s em cada home aberta), em ms |
| `hypeplay.http.requests` | Pedidos por classe de status (`2xx`, `4xx`, `5xx`, `101` para WebSocket) |
| `hypeplay.ratelimit.rejected` | Pedidos recusados pelo limite por pessoa (`action`) |
| `hypeplay.backup.last_ok` | Quando foi feito o último backup completo no R2 (Unix, em segundos; lido do R2 ao subir; `0` se não há nenhum, e nenhum ponto enquanto o R2 não respondeu à listagem). Para um alerta: agora menos isso acima de 26 h |
| `hypeplay.backup.failures` | Backups que falharam desde que o app subiu |
| `hypeplay.build.duration` | Duração das compilações em segundos, por `mode` (`full`, `learn`, `recomp`, `page`) e `result` (`ready`, `failed`, `gone`) |

### Ligar o TURN

O vídeo do jogador 2 vai direto do navegador do host para o do convidado. Quando uma das redes não aceita conexão
de fora (CGNAT, 4G, roteador fechado), os dois só se falam por um retransmissor, o TURN. O app oferece aos navegadores
o TURN da Cloudflare, se tiver chave; senão só STUN (e a tela do jogador 2 diz que faltou um TURN). O relé pelo
próprio servidor fica desligado (`NO_RELAY` em `page/online.ts`): de longe (o servidor fica no Canadá) ele passa de 300 ms.

O TURN da Cloudflare é anycast: cada jogador cai no ponto de presença mais perto dele
(São Paulo, Rio, Fortaleza…), uns 40 a 80 ms entre dois jogadores no Brasil, sem servidor no Brasil. 1.000 GB por
mês de graça, depois US$ 0,05 por GB; só conta o que passa pelo TURN.

1. Em [dash.cloudflare.com](https://dash.cloudflare.com), **Realtime → TURN → Create**. Nome livre (`hypeplay`).
   A Cloudflare mostra o **Turn Token ID** e o **API Token** uma única vez.
2. No Dokploy, em **Environment**:
   ```
   TURN_CF_KEY_ID=<Turn Token ID>
   TURN_CF_TOKEN=<API Token>
   ```
   O token fica só aí: nunca no git, em chat ou em log. Se se perder, apague a chave e crie outra.
3. Faça o deploy de novo. O app pede à Cloudflare uma credencial de 12 h, uma para todos os jogadores, e renova uma
   hora antes de vencer. Se a Cloudflare não responder, o jogo segue só com STUN e tenta de novo em 30 s.

**Conferir:** `GET /p/<passe>/ps2/<jogo>/ice` devolve a lista que vai aos navegadores: o segundo item é o TURN da
Cloudflare (`turn.cloudflare.com`). Se mesmo assim o jogador 2 não conectar, a tela dele diz se o TURN respondeu
("O TURN não respondeu": a rede dele bloqueia tudo que não é web) e a barra dele mostra o caminho em uso (`direto`, `TURN`, `rede local`), o ping e os fps.

### Cache dos discos e dos arquivos

O servidor fica no Canadá e os jogadores, no Brasil, entrando pelo proxy do Discord: o que custa é a ida e volta por
pedaço que falta (medido em nov/2026: um GET no R2 de dentro da VPS leva 85–140 ms; 1 MB pelo proxy, 280–530 ms).
Três caches, do servidor ao navegador:

- **Pedaços dos discos na memória do app** (`server/chunkcache.ts`): dos discos que estão no R2, em pedaços de 1 MiB
  alinhados no disco, os menos usados saindo primeiro passado `DISC_CACHE_MB`. Duas pessoas no mesmo jogo, ou um menu
  lido de novo, não repetem o GET no R2; dois pedidos do mesmo pedaço ao mesmo tempo viram um GET só. Um pedido de
  vários pedaços busca cada um em paralelo e já manda o primeiro enquanto os outros chegam. A chave leva o tamanho e a
  hora da marca (`disc.iso.r2`): um disco enviado de novo com o mesmo nome é outro. Os discos no disco do servidor não
  passam por ele (o sistema já guarda o arquivo).
- **No navegador, por endereço com versão:** os scripts do app (`pad.js?v=…`, `entry.js?v=…`), os arquivos do
  TabStationToo que ele mesmo pede com `?v=<build>`, o `ps2web.js/.wasm/.data` da versão rápida (`?v=` das datas e
  tamanhos do build, posto pelo servidor na página) e as capas vão com
  `Cache-Control: public, max-age=31536000, immutable`, mas só quando o `?v=` pedido é o atual; um endereço velho ou
  sem versão volta com `no-cache`. O `disc-worker.js` do motor nunca (leva o nosso `disccache.js` no fim, que muda sem o
  build mudar). Como todo endereço leva o passe (`/p/<passe>/`, novo a cada entrada), esse cache vale por um passe.
- **No disco do navegador, entre uma entrada e outra:** os blocos do disco (`page/disccache.ts`, Cache Storage) e,
  na versão rápida, o `ps2web.wasm` e o `ps2web.data` (~15 MB; `page/fastcache.ts`, Cache Storage `hypeplay-fast`), pela
  versão e sem o passe: abrir o jogo de novo não baixa o motor de novo. Sem Cache Storage (origem opaca, armazenamento
  bloqueado ou cheio), tudo vem da rede como antes. Uma versão nova apaga a anterior do mesmo jogo.

### Edge para os discos (opcional)

Desligado. Um Cloudflare Worker (`edge/worker.ts`) que serve os discos do R2 por Range e guarda os pedaços de 1 MiB no
Cache API do data center que atendeu (São Paulo, Rio…): o segundo jogador da região, ou um menu lido de novo, não vai
nem ao R2. O app só dá o endereço; o Worker confere um token assinado pelo app (HMAC com `DISC_EDGE_SECRET`, 12 h,
`server/edgetoken.ts`, o mesmo código dos dois lados) e só serve discos (`…/ps2/<id>/game/disc.iso`). O tamanho e a
versão do disco vêm assinados no endereço, então um pedaço que o data center já tem sai sem nenhuma pergunta ao R2. Só
vale dentro do Discord: lá o Worker é um caminho do próprio `<client id>.discordsays.com` (URL Mapping), então é a mesma
origem e o isolamento que o emulador pede continua valendo. Fora do Discord (aba do navegador) e para os discos que
estão no disco do servidor, nada muda.

Para ligar (nada disso está feito):

1. **Domínio do Worker:** um subdomínio de um domínio seu na Cloudflare (ex. `disc-edge.exemplo.com`). Não serve
   `*.workers.dev`: lá o Cache API não guarda nada.
2. **`edge/wrangler.toml`:** troque `bucket_name` pelo bucket do `S3_BUCKET` e o `pattern` pelo domínio do passo 1.
3. **Segredo:** gere um (`openssl rand -base64 48`) e guarde no Worker:
   `bunx wrangler secret put DISC_EDGE_SECRET --config edge/wrangler.toml`.
4. **Publicar o Worker:** `bunx wrangler deploy --config edge/wrangler.toml`. Conferir: sem token,
   `https://disc-edge.exemplo.com/p/edge/ps2/<id>/game/disc.iso` responde 403.
5. **Discord → Activities → URL Mappings:** acrescente `/p/edge` → `disc-edge.exemplo.com`, ao lado do `/` do app.
   Confira que `https://<client id>.discordsays.com/p/edge/ps2/<id>/game/disc.iso` chega no Worker (403 "Acesso
   vencido" sem token) e não no app (que responderia 403 "Acesso vencido: feche e abra a atividade de novo."). Se o
   Discord só encaminhar pelo `/.proxy/`, use `/.proxy/p/edge` no passo 6.
6. **No Dokploy**, em **Environment** do app: `DISC_EDGE_URL=/p/edge` (o caminho do passo 5) e
   `DISC_EDGE_SECRET=<o mesmo do passo 3>`. Faça o deploy de novo.

Ligado, a página do emulador de um jogo cujo disco está no R2 ganha
`<meta name="hypeplay-disc" content="/p/edge/ps2/<id>/game/disc.iso?s=…&v=…&t=…">` e, dentro do Discord, o emulador
lê o disco de lá (`page/ps2play.ts`, `page/edgedisc.ts`). O caminho termina igual ao do emulador e começa com
`/p/<nome>/`, como um passe: o cache em disco do navegador (`page/disccache.ts`) dá ao disco o mesmo nome
(`/ps2/<id>/game/disc.iso`), então os blocos já guardados, o "Baixar tudo" do painel e a versão rápida
(`page/fastdisc.ts`, que guarda sob esse mesmo nome) continuam os mesmos. A versão rápida segue lendo o que falta pelo
servidor; ligar o edge nela é ensinar o `fastdisc.ts` a buscar a rede no endereço do edge. Para desligar, tire as duas
variáveis.

### Workers em outra máquina

A versão rápida pesa (2 CPUs por 20 a 40 minutos por jogo) e roda na mesma VPS do app. Ela vai para outras máquinas
com a mesma imagem do `ps2-builder`: cada uma é mais um worker da fila de compilações, e cada jogo vai para um worker
só (nunca dois compilam o mesmo). Elas não montam o volume: falam com o app por HTTPS (`/worker/`, com um token),
trazem o disco do R2 e publicam a versão rápida no R2, e o app serve de lá (cada carregamento passa pela VPS, sem
cache). Precisa do R2 ligado no app (`S3_BUCKET` e companhia; com `WORKER_TOKEN` e sem R2 o app não sobe) e, nos
workers, as mesmas credenciais do **mesmo bucket**.

1. No Dokploy, em **Environment** do app, acrescente um token longo e aleatório (`openssl rand -hex 32`):
   ```
   WORKER_TOKEN=<token>
   ```
   Faça o deploy de novo. Sem ele, `/worker/` nem existe.
2. Na outra máquina (Linux com Docker, 2 CPUs e uns 4 GB de memória por worker, ~10 GB de disco), com uma cópia do
   repositório:
   ```sh
   docker build -t hypeplay-ps2-builder -f ps2-builder/Dockerfile .
   docker run -d --restart unless-stopped --cpus 2 --name ps2-worker \
     -e QUEUE_URL=https://bt3.exemplo.com \
     -e WORKER_TOKEN=<token> \
     -e S3_BUCKET=… -e S3_ENDPOINT=… -e S3_ACCESS_KEY_ID=… -e S3_SECRET_ACCESS_KEY=… \
     -e WORKER_ID=casa-1 \
     -v ps2-worker-data:/app/data \
     hypeplay-ps2-builder
   ```
   `QUEUE_URL` é o endereço do app (o mesmo do `PUBLIC_URL`). `WORKER_ID` é opcional: o nome que aparece nos logs e
   na fila. O volume é só desta máquina: os arquivos da compilação (`ps2-work/`) e o disco enquanto compila
   (`ps2-work/<serial>/disc.iso`, trazido só se couber com a mesma margem do envio; se não, o jogo volta para a fila).
3. `docker logs -f ps2-worker` mostra `taking jobs from https://…` e cada jogo que ele pega. Na gaveta do jogo, o
   progresso aparece como se fosse aqui.

Mais workers, mais jogos ao mesmo tempo: na mesma máquina (outro `--name` e outro volume) ou em outras. O
`ps2-builder` da VPS continua pegando jogos também; para tirar a compilação de lá, pare esse serviço no Dokploy.

- **Mesma imagem em todos.** Uma versão rápida feita com outra página ou outro ps2-web-recomp é atualizada pelo
  primeiro worker livre: workers com imagens diferentes ficariam atualizando os mesmos jogos um por cima do outro.
  Ao atualizar o repositório, refaça a imagem nas outras máquinas também.
- **Se um worker cair** no meio, o jogo volta para a fila depois de 2 minutos sem notícia e outro pega (até 3 vezes;
  depois a gaveta mostra a falha e o **Tentar de novo**). Um erro que não é da compilação (R2 fora do ar, rede) também
  volta para a fila, com uma pausa.
- **Um jogo com código novo** (o que os jogadores acharam) compila só esse código no worker que já tem a tradução do
  jogo; noutro, refaz tudo antes.
- Os discos que ainda estão no disco da VPS (enviados antes do R2) vão para o worker pelo próprio app.

## Acesso

A atividade abre em `/`: a página de entrada pede ao Discord um código (`authorize`, escopo `identify`) e o
troca em `POST /token`. O servidor troca o código pelo usuário do Discord e devolve um passe assinado aqui
mesmo (HMAC, 12 h): sem passar pelo Discord, não há passe. A entrada então abre a home num iframe em
`p/<passe>/`, e cada jogo em `p/<passe>/ps2/<id>/` (estado, envio, `game/`). Tudo mora sob esse caminho, porque o iframe não manda cabeçalhos e, no Discord, não tem
cookie. Sem passe válido, tudo ali responde 403. A entrada e o ícone são públicos; só o Discord pode
emoldurar as páginas.

## Arquivos

Tudo fica no volume, `/app/data/`, e nada disso vai para o git nem para imagem nenhuma (`data/` está no
`.gitignore`). Os jogos de PS2 ficam em `/app/data/ps2/<serial>/` (`game.json`, `cover.webp`, `disc.iso`, e `fast/` com a versão
rápida: o pedido, `build.log`, `misses.txt` e `build/`; feita em outra máquina, ela fica no R2, em
`ps2/<serial>/fast/<versão>/`) e a BIOS em `/app/data/bios/`. A fila de compilações é `/app/data/queue.db` (SQLite,
um arquivo só dela, fora do Postgres): cada jogo pedido, quem está compilando, e como foi. Na primeira subida com
ela, os pedidos que já estavam no volume entram sozinhos (uma versão pronta continua pronta, sem compilar de novo). O que a
compilação da versão rápida gera fica em `/app/data/ps2-work/<serial>/` (uns 300 MB por jogo); um disco que está no R2
vem para `ps2-work/<serial>/disc.iso` só enquanto compila (nunca para a pasta do jogo, de onde o app lê os discos) e
o `ps2-builder` apaga, na subida, o que um build interrompido deixou ali. A lista da biblioteca
sai de um índice em memória, montado dos `game.json` na subida. De 10 em 10 minutos uma limpeza passa pelo disco do
servidor, e só por ele (nada no R2 é apagado sem alguém clicar em "Remover"): reservas abandonadas, envios parados há
24 horas e pastas sem `game.json` saem, mas uma pasta sem `game.json` com disco (`disc.iso` ou `disc.iso.r2`) fica,
com um aviso no log, à espera de alguém. Ela também apaga o `disc.iso.part` de uma cópia cortada e, com o R2 ligado,
a cópia local de um disco que já está no R2, e manda de novo ao R2 (um por vez) o disco que ficou aqui porque a
subida foi cortada (um deploy, um erro). Um erro do disco ao olhar uma pasta (não um arquivo que falta) pula essa
pasta. Restaure um backup com o app parado. Os memory cards são `saves/<serial>/<id do Discord>.ps2`. A intro opcional é
`/app/data/intro.mp4` (enviada pela tela Servidor).

O resto do que é de cada pessoa fica no Postgres (serviço `postgres`, volume `postgres`, fora do `/srv/bt3-data`):
mapas de controle, teclas, volume e filtro, último jogo, e o social (perfis, amigos e pedidos, horas por jogo,
sessões recentes, com quem jogou, status). Convites ficam só em memória. Com o R2 ligado, o banco entra no
[backup automático](#backup-automático) diário; à mão, um dump e a volta:

```sh
docker compose exec -T postgres pg_dump -U hypeplay hypeplay > hypeplay.sql
docker compose exec -T postgres psql -U hypeplay hypeplay < hypeplay.sql
```

O que veio antes fica no `/app/data`, parado: os arquivos `social.json`, `pads/`, `keys/`, `users/` e `prefs/` (e,
onde rodou a versão em SQLite que passou pelo `main`, um `hypeplay.db`). Na primeira subida com o Postgres o
`hypeplay.db` é copiado inteiro, se houver, e os arquivos entram no que ele não tiver marcado; cada um uma vez só (a
tabela `imported` marca), e nada é apagado. Dá para apagá-los depois de conferir.

**Refazer do zero:** um jogo: "Remover" na biblioteca; só a versão rápida: "Apagar a versão rápida" na gaveta do jogo.

### Backup automático

Com o R2 ligado (`S3_BUCKET`), o `app` faz sozinho, uma vez por dia, um backup do que só existe na VPS
(`server/backup.ts`). Não há nada para configurar no Dokploy; `BACKUP=0` desliga. Ao subir, se o último backup no R2
tem mais de 24 h (ou não existe), o próximo sai 10 minutos depois; senão, quando ele fizer 24 h; e daí a cada 24 h.
Se um backup falha (o R2 fora do ar, por exemplo), o app segue normalmente, registra o erro no log e tenta de novo em
1 h. Um backup também não começa enquanto o servidor desliga.

E não sai backup de um app sem jogos (nenhum `ps2/*/game.json`) ou sem pessoas no banco (nenhuma linha fora de
`imported`): isso é uma VPS nova, ou o volume ou o banco perdidos, e um backup assim seria o "mais recente" e
empurraria os bons para fora dos 14. O log avisa (`backup: skipped`), não conta como falha, e o `last_ok` envelhece
até o alerta disparar.

Cada backup é uma pasta no mesmo bucket, `backup/<AAAA-MM-DDTHHMM>/` (hora UTC), com:

| Arquivo | O que tem |
| --- | --- |
| `postgres.json` | Todas as tabelas do banco, linha por linha, lidas de uma vez só (as tabelas são descobertas na hora: uma tabela nova entra sozinha) |
| `queue.db` | A fila de compilações, numa cópia consistente (`VACUUM INTO`) |
| `data.tar.gz` | Os arquivos pequenos do volume: de cada jogo, `game.json`, `cover.webp` e a marca `disc.iso.r2` (sem ela o app não sabe que o disco está no R2); `fast/` (o pedido, `misses.txt`, `build.log`), mas não o `build/`; a BIOS (`bios/`); os memory cards que ainda estão no disco (`saves/`, de antes do R2); e os arquivos soltos da raiz (`social.json`, `hypeplay.db`) |
| `manifest.json` | Gravado por último: o tamanho e o SHA-256 de cada arquivo, quantas linhas tem cada tabela e quantos jogos vieram. Uma pasta sem ele é um backup que não terminou e nunca conta como o último |

Ficam os 14 backups completos mais recentes; os mais velhos, e os incompletos que sobraram de uma falha, são apagados
depois de cada backup novo. O tar é montado na memória do app e costuma ter poucos MB. Dois tetos o protegem: cada
arquivo até 16 MB e o volume inteiro até 256 MB. Os memory cards entram por último, então são eles que ficam de fora
quando o total passa do teto.

**Fica de fora:** os discos (`disc.iso`: os do R2 já estão lá; um que esteja só na VPS se perde com ela), os envios em
andamento (`upload/`, `*.part`), `vimm/`, `ps2-work/`, a versão rápida compilada na VPS (`fast/build/`: na
restauração ela volta para a fila e é compilada de novo; a feita em outra máquina já está no R2, e o `queue.db` diz
onde), a intro (`intro.mp4`: material da Sony, é só enviar de novo pela tela Servidor), as pastas antigas `pads/`,
`keys/`, `users/` e `prefs/` (já estão no banco) e o que passar dos tetos acima (o log avisa quais). Os memory cards
no R2 e os discos no R2 não são copiados: o backup guarda o que diz o que eles são.

**Restaurar** (VPS nova, ou volume e banco perdidos): suba a stack com o mesmo `S3_*`, um `/srv/bt3-data` vazio e
`BACKUP=0` no Dokploy (tire depois da restauração, e faça o deploy de novo), pare o `app` e o `ps2-builder` (o `postgres` fica de pé) e rode o `scripts/restore.ts` na imagem do app. O Dokploy
sobe o compose com um nome de projeto próprio: use o que aparece em `docker compose ls` (a coluna `CONFIG FILES` diz
a pasta do compose; rode os comandos nela). Sem o `-p` certo, o `run` cai numa rede sem o `postgres`.

```sh
P=<projeto>   # docker compose ls
docker compose -p $P stop app ps2-builder
docker compose -p $P run --rm --no-deps app bun scripts/restore.ts --list                   # os backups no R2
docker compose -p $P run --rm --no-deps app bun scripts/restore.ts                          # o mais recente
docker compose -p $P run --rm --no-deps app bun scripts/restore.ts --from 2026-11-11T0310   # um escolhido
docker compose -p $P start app ps2-builder
```

Sem `--from`, ele pega o backup completo mais recente que tenha jogos e pessoas no banco; um mais novo sem eles é
deixado de lado (ele diz quais) e só volta com `--from`. Um nome sem `--from`, ou qualquer outro argumento, é
recusado. Ele baixa o backup e confere cada arquivo pelo manifesto. Depois cria as tabelas (o `migrate` do `server/db.ts`),
regrava as linhas numa transação só, extrai o tar no `/app/data` e troca o `queue.db`. Ele recusa se o banco ou o
volume já tiverem dados. Não contam as marcas `imported` nem o `queue.db` vazio, que o app grava quando sobe pela
primeira vez. Com `--force`, as tabelas são esvaziadas antes e os arquivos, sobrescritos.

Ele também confere no R2 o que o backup diz que está lá. Uma versão rápida feita em outra máquina cujo build saiu do R2
depois do backup (trocado por um mais novo) volta para a fila. Um jogo cujo disco saiu do R2 ("Remover") perde a
marca `disc.iso.r2`. No fim ele lista os jogos sem disco, os que estavam só na VPS e esses, e a limpeza do app os
remove.

A restauração não é atômica: o banco é gravado antes do tar e do `queue.db`. Se ela parar no meio (o disco cheio, por
exemplo), o banco já está cheio e um novo `restore.ts` recusa; repita com o mesmo `--from` e `--force`.

Sempre com o app parado, e com uma versão do app cuja limpeza (o `sweep` do `server/library.ts`) não apague do R2 as
pastas sem `game.json`: uma pasta com a marca e sem o `game.json` faz a limpeza apagar o disco do R2 (o branch
`escala/discos-seguros` corrige isso). O tar traz o `game.json` junto com as marcas, então, com o app parado
durante a restauração, cada pasta volta inteira.

## Local

```sh
bun install
# um Postgres só para isto, na porta 55432 (os testes usam um schema cada e apagam depois)
docker run -d --name hypeplay-pg -p 127.0.0.1:55432:5432 -e POSTGRES_USER=hypeplay -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=hypeplay postgres:17-alpine
TEST_DATABASE_URL=postgres://hypeplay:dev@127.0.0.1:55432/hypeplay bun test   # sem a variável, os testes do banco são pulados
DATABASE_URL=postgres://hypeplay:dev@127.0.0.1:55432/hypeplay DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… bun run start   # porta 3003; os arquivos em data/
```

O Discord só abre a atividade por HTTPS: exponha a porta 3003 num túnel (ex. `cloudflared tunnel --url
http://localhost:3003`) e ponha o domínio do túnel no URL mapping `/` de um app de teste.

Para abrir a biblioteca sem o Discord, gere um passe com o mesmo segredo e abra `http://localhost:3003/p/<passe>/`:

```sh
bun scripts/pass.ts "$DISCORD_CLIENT_SECRET" 42 Ana
```

## Por dentro

- `server/`: entrada pelo Discord (`discord.ts`), passe (`pass.ts`), rotas (`routes.ts`), envio da ISO
  (`upload.ts`), a biblioteca (`library.ts`), o serial pelo `SYSTEM.CNF` (`iso9660.ts`), capas (`cover.ts`), saves (`saves.ts`),
  mapas de controle e último jogo (`people.ts`), amigos e horas (`social.ts`), o banco dos dois no Postgres (`db.ts`),
  salas e ICE do online (`ps2rooms.ts`, `ice.ts`), as respostas com
  Range, isolamento e versão (`http.ts`), os discos no R2 (`discs.ts`) e os pedaços deles na memória (`chunkcache.ts`).
  A home ao vivo (`homefeed.ts`) e quem está por perto (`presence.ts`). A fila de compilações (`queue.ts`, SQLite:
  cada job vai para um worker só, com prioridade, prazo e novas tentativas), o lado do volume dos jobs da versão rápida
  (`fastjobs.ts`) e a fila para os workers de fora (`workers.ts`, `/worker/`). O backup diário para o R2
  (`backup.ts`), restaurado por `scripts/restore.ts`.
- `edge/`: o Worker opcional que serve os discos do R2 perto dos jogadores (`worker.ts`, `wrangler.toml`), com o
  token de `server/edgetoken.ts`. Nada aqui o publica.
- `page/`: a entrada (`entry.html` e `entry.ts`, empacotado com o SDK do Discord quando o servidor sobe), a
  home (`index.html` e `home/`: biblioteca, envio, progresso, controle, servidor, intro) e os scripts empacotados ao subir: `pad.js` (o controle mapeado dentro dos jogos, de
  `pad.ts` e `padmap.ts`) e `iso.js` (o serial no navegador).
- `server/ops.ts`, `limits.ts`, `log.ts`, `otlp.ts`: em volta das rotas, o `/health`, os limites por pessoa, as
  métricas e o desligamento limpo; o log em JSON; o envio por OpenTelemetry (sem dependências, o `ps2-builder` usa
  também).
- `.github/workflows/ci.yml`: em cada PR e push, `bun test`, `bun run typecheck` e o build das duas imagens (sem
  segredos, sem deploy: o Dokploy faz o deploy do `main` sozinho).
- `ps2-builder/`: a imagem e o worker da versão rápida (ps2-web-recomp, `builder.ts`), e de onde vêm os jobs
  (`jobs.ts`: a fila e o volume daqui, ou o `/worker/` do app e o R2). O `patch.ts` ajusta a página dele e falha alto
  se o recompilador mudar.
- `emulator/ps2-fetch.ts` e `ps2-files.json`: baixam o TabStationToo (GPL-3.0) e conferem cada arquivo por SHA-256;
  `--update` pega a versão publicada agora e regrava os hashes (depois revise `server/ps2page.ts`).
- `server/ps2page.ts` e `page/ps2play.ts`: a página do TabStationToo no nosso design (BIOS e disco do servidor,
  memory card do servidor no slot 1, o console dele escondido, a nossa barra e o rodapé da licença).
