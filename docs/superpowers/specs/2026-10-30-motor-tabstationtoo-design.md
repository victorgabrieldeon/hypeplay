# Jogos de PS2 pelo TabStationToo — design (substitui o ps2-web-recomp)

Data: 2026-10-30. Branch: `feat/biblioteca-ps2`. Complementa
[`2026-10-30-biblioteca-ps2-design.md`](2026-10-30-biblioteca-ps2-design.md): o que esta spec não muda (biblioteca,
envio, capas, saves por pessoa, controle, intro, volume e filtro, home, salas) continua valendo como lá.

## Por que trocar

O ps2-web-recomp compila cada jogo (10–30 min, ~300 MB) e só levou dois jogos até o fim. O
[TabStationToo](https://github.com/TabStationToo/TabStationToo) é o **PCSX2 inteiro em WebAssembly** (JIT próprio
para wasm, WebGPU, threads): roda a ISO direto, sem compilar, com a compatibilidade do PCSX2. O teste na branch
(2026-10-30) rodou o BT3 do dono, servido pelo nosso servidor com os nossos cabeçalhos, a **100–102% da velocidade,
~60 VPS, WebGPU, zero quadros perdidos**, lendo a BIOS e o disco pelas nossas rotas.

## Como fica para quem usa

1. **Só na primeira vez do servidor:** quem adicionar o primeiro jogo de PS2 envia também a **BIOS do PS2** (o
   arquivo de 4 MB do console dele). Ela fica guardada no servidor e **nunca mais é pedida** a ninguém.
2. **Uma vez por jogo:** alguém envia a **ISO** do jogo (com capa, se quiser). Ela fica **guardada no servidor**,
   e o jogo entra na biblioteca **para todo mundo, para sempre**: ninguém precisa enviar de novo.
3. **Daí em diante:** abriu a atividade, escolheu o jogo na biblioteca, clicou em **Jogar**: a intro toca e o jogo
   liga direto, quando quiser, sem esperar compilação e sem enviar nada. O save de cada pessoa fica no servidor e
   volta na próxima vez.
4. **Com um amigo:** quem está jogando clica em "Abrir sala"; o amigo clica em "Entrar como jogador 2" na
   biblioteca.

## Decisões

| Pergunta | Decisão |
| --- | --- |
| Motor dos jogos de PS2 | TabStationToo (GPL-3.0), versão publicada fixada por SHA-256 de cada arquivo |
| Compilação por jogo | Nenhuma: a ISO conferida já é jogável |
| BIOS | Enviada uma vez para o servidor todo (`data/bios/bios.bin`), por quem adicionar o primeiro jogo de PS2; trocável depois |
| Página do jogo | A do TabStationToo, **no nosso design**: o "console/TV" dele some, o jogo ocupa a tela, e ficam só o nosso painel (`overlay.js`) e a nossa barra mínima |
| Saves | O memory card dele (o mesmo `.ps2` de 8 MB) carregado de e salvo em `../save`, um por pessoa |
| Online | Streaming nosso: o host transmite tela e som por WebRTC; o controle do convidado entra como **jogador 2** por um controle virtual (`pad.js`); salas e TURN como já estão |
| O que sai | `ps2-builder/` inteiro, o serviço no compose, os estados de compilação (`queued`, `building`, capturas, `note`), `PS2_STEPS`, a rota `shots` |
| BT3 | Continua no port dele (com o Dragon Net Battle). O serial dele segue apontando para o port no assistente |

## Premissas e limites

- **Licença:** o TabStationToo é GPL-3.0. Servimos os arquivos como vieram, com o `COPYING.GPLv3` e um link para o
  código-fonte na página do jogo (rodapé "Emulador: TabStationToo (GPL-3.0) — código"). Nada nosso é misturado
  ao código dele: o ajuste é um patch aplicado na hora de servir.
- **BIOS:** é software da Sony. Mesma regra da ISO: só no volume, nunca no git nem em imagem. O assistente diz que
  é a BIOS de um PS2 que a pessoa tem.
- **Versão:** não há release nem branch de páginas; os arquivos vêm do site publicado
  (`https://tabstationtoo.github.io/TabStationToo/`) e são conferidos por SHA-256 no build da imagem. Atualizar é
  rodar `bun emulator/ps2-fetch.ts --update` (regrava os hashes) e revisar o patch.
- **Navegador:** o mesmo de antes (isolation; WebGPU + JSPI para o renderizador por hardware, senão ele cai no
  renderizador por software em canvas 2D, lento). Sem celular (o próprio projeto não suporta).
- **Compatibilidade:** a do PCSX2 no port web, ainda "early and experimental" segundo o projeto; o selo
  "Experimental" e o aviso continuam, com o texto ajustado.

## Arquitetura

```
app (Bun) ─ /p/<passe>/ps2/<id>/game/          → index.html do TabStationToo + patch (nosso design, saves, salas)
          ─ /p/<passe>/ps2/<id>/game/<motor>   → pcsx2-wasm.{js,wasm,data}, disc-worker.js, audio-tap.js, … (lista fixa)
          ─ /p/<passe>/ps2/<id>/game/disc.iso  → a ISO com Range (já existe)
          ─ /p/<passe>/bios.bin                → a BIOS (só com passe; isolada; Range)
          ─ /p/<passe>/bios  GET/PUT           → existe? / enviar (validada)
          ─ /p/<passe>/watch/?room=…           → a página do convidado (nossa), sem motor
```

### Motor (`emulator/ps2-fetch.ts`, `emulator/ps2-files.json`)

- Lista fixa de arquivos com SHA-256: `index.html`, `app.js`, `isolation.js`, `pcsx2-wasm.js`, `pcsx2-wasm.wasm`,
  `pcsx2-wasm.data`, `disc-worker.js`, `audio-tap.js`, `cable-worker.js`, `icons.svg` e os que o `app.js` pedir
  (levantados ao implementar, pela aba de rede), mais `COPYING.GPLv3` do repositório no commit
  `5a9a7b489e428f3cea87d52621429f749c969f41`.
- `bun emulator/ps2-fetch.ts` baixa para `emulator/ps2/` e falha se algum hash não bater; roda no `Dockerfile` do
  `app`, como o `emulator/fetch.ts` do EmulatorJS. `--update` baixa e regrava `ps2-files.json`.
- `emulator/ps2/` vai no `.gitignore` e no `.dockerignore` (como `emulator/data`).

### Página do jogo (patch na hora de servir: `server/ps2page.ts`)

O servidor serve o `index.html` dele com um patch fail-loud (mesma ideia do `builder/patch.ts`, testado contra o
arquivo real fixado em `server/fixtures/tabstation-index.html`):

- **Boot direto:** um script nosso antes do `app.js` reescreve a URL para `?bios=../../../bios.bin&disc=disc.iso`
  (mesma origem, como o motor exige) com `history.replaceState`, então o jogo liga sozinho ao abrir.
- **Nosso design:** uma folha de estilo nossa esconde o "console/TV", a biblioteca de discos, os cartões e as abas
  dele, e deixa o canvas do jogo ocupando a tela (fundo `--bg`, `object-fit: contain`). Por cima, só uma barra
  mínima nossa (no topo, discreta como o botão do `overlay.js`): "← Biblioteca", nome do jogo, e "Abrir sala"
  (online). Mensagens dele que importam (falta de WebGPU, erro de disco/BIOS, "lento") aparecem num aviso no nosso
  estilo, lidas do próprio texto que ele mostra.
- **Saves:** a biblioteca de memory cards dele vive no IndexedDB; o patch carrega o card de `../save` no slot 1
  antes do boot e, quando o jogo grava (o evento de escrita do card que ele já trata), faz `PUT ../save`. Detalhe
  exato da API levantado ao implementar; se o IndexedDB não existir na janela, segue só com o servidor.
- **Áudio:** passa pelo `volume.ts` como qualquer jogo (o `audio-tap.js`/AudioWorklet dele conecta no destino).
- **Rodapé de licença:** "Emulador: TabStationToo (GPL-3.0) · código-fonte".

### BIOS

- `server/bios.ts`: `validBios(bytes)` = 4 MiB e, nos primeiros 64 KiB, a entrada `RESET\0` seguida, 16 bytes
  depois, de `ROMDIR`. `GET bios` → `{ present, size?, by?, at? }`; `PUT bios` (só sem BIOS, ou com `?replace=1`)
  grava `data/bios/bios.bin` (+ `bios.json` com quem e quando), troca atômica. `GET bios.bin` serve o arquivo com
  Range e os cabeçalhos de isolamento (só sob o passe).
- **Assistente:** se não houver BIOS, o passo 2 vira "BIOS do seu PS2" (arquivo de 4 MB, `.bin`/`.ROM0`), com a
  mesma validação no navegador antes de enviar; depois segue para a ISO. Com BIOS, o passo não aparece.
- **Estado de um jogo de PS2:** `empty` → `uploading` → `ready` (ISO conferida) — ou `needs-bios` quando falta a
  BIOS no servidor. Sem `queued`/`building`/`offline`.

### Online por streaming

- **Host** (página do jogo): "Abrir sala" cria a sala (`ps2rooms`, já existe) e espera convidados; para cada um
  abre um `RTCPeerConnection` com a tela (`canvas.captureStream(60)`) e o som (o ganho do `volume.ts` também
  alimenta um `MediaStreamAudioDestinationNode`), e um canal de dados `pad` (não ordenado, sem retransmissão).
  O que chega no canal vira o **controle virtual "CordPlay convidado"** do `pad.js`, fixado na porta 2.
- **Convidado** (`page/watch.html` + `page/watch.ts`, nosso design): vídeo em tela cheia, lê o próprio controle
  (com o mapa dele) ou o teclado, manda o estado a cada quadro pelo canal; mostra "Conectando…", "Sem conexão
  com o host (talvez precise de um TURN)" depois de 15 s, e "A sala acabou" voltando para a biblioteca. Não
  precisa de isolation, WebGPU nem BIOS: abre dentro do Discord.
- **Sinalização:** as rotas de sala passam para `/p/<passe>/ps2/<id>/room*` (fora de `game/`, para a página do
  convidado também usar) — oferta, resposta e candidatos como mensagens JSON.
- **Home:** "Entrar como jogador 2" abre `ps2/<id>/watch/?room=<código>` (com a intro).

## Erros (novos)

| Situação | O que acontece |
| --- | --- |
| Arquivo que não é BIOS de PS2 | Recusado no navegador e no servidor: "Isso não parece a BIOS de um PS2 (arquivo de 4 MB)" |
| Jogo sem BIOS no servidor | Estado `needs-bios`: o card mostra "Falta a BIOS" e a gaveta pede o envio |
| Motor com hash diferente no build | O build da imagem falha com o arquivo e os dois hashes |
| Patch não acha um trecho do `index.html` | O servidor serve uma página de erro "Emulador mudou: revise server/ps2page.ts" e registra; teste falha antes |
| Sem WebGPU | O aviso dele, no nosso estilo; roda em software (lento) |
| Convidado sem conexão em 15 s | Aviso do TURN; o host segue jogando |

## Testes

- `server/bios.test.ts` — validação (tamanho, ROMDIR), envio, troca só com `replace`, `bios.bin` com Range e
  isolamento, sem passe 403.
- `server/ps2page.test.ts` — patch contra o `index.html` real fixado: boot direto, estilo nosso, saves, barra,
  rodapé; falha alto se um trecho sumir.
- `server/routes.ps2.test.ts` — arquivos do motor só da lista fixa e isolados; estado `needs-bios`/`ready`;
  salas em `ps2/<id>/room*`; `watch/` servida.
- `emulator/ps2-fetch.test.ts` — hash certo grava, hash errado falha com o nome do arquivo (servidor HTTP falso).
- `page/stream.test.ts` — o controle virtual entra na porta 2 a partir das mensagens do canal (sem WebRTC real).
- Remover os testes do `ps2-builder`.
- Manual (navegador interno, depois Discord): BT3 pela biblioteca de PS2 no nosso design, save persiste, filtro e
  volume, duas abas host/convidado jogando como jogador 2.

## Fora deste trabalho

- Compilar o TabStationToo a partir do código (usamos a versão publicada, conferida por hash).
- Estados salvos (save states) no servidor; cartões além do slot 1.
- Netplay de verdade (os dois rodando o jogo em sincronia).
