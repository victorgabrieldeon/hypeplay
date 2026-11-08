# HypePlay — design system

Direção: **"Mosaico"**. A biblioteca é uma parede de capas no escuro de cinema; a interface só aparece onde é preciso
(uma barra fina no topo, as palavras à esquerda, a gaveta do jogo). Preto de verdade, um acento coral contido: as
capas são o que tem cor. Tudo vira CSS variables em `page/index.html` (`--nome`); as páginas usam nomes, nunca
valores. As direções exploradas até aqui (e a escolha) estão em `docs/estilos/`.

## Cor

| Token | Valor | Papel |
| --- | --- | --- |
| `--bg` | `#000` | Fundo da página e da parede |
| `--side` | `#0a0a0a` | Gaveta, janelas, card "Adicionar jogo" |
| `--surface` | `#111112` | Caixas, campos, fundo da capa enquanto carrega |
| `--surface-hi` | `#18181a` | Hover de linha e de caixa, trilho de barra |
| `--surface-top` | `#232325` | Contadores, chips |
| `--line` / `--line-hi` | branco a 8% / 14% | Divisórias / contorno de botão secundário, campo e gaveta |
| `--ink` | `#f4f2f3` | Texto principal |
| `--soft` | `#a6a2a4` | Texto secundário (≥7:1 sobre o preto) |
| `--faint` | `#6b6869` | Só ícones e ilustrações; nunca texto |
| `--primary` | `#ff5a8a` | Coral: botão primário, seção ativa, a capa da gaveta aberta, barra de progresso, seleção de texto |
| `--primary-hi` | `#ff7aa1` | Hover do primário |
| `--on-primary` | `#000` | Texto sobre o coral (o branco não passa de 3:1) |
| `--accent` | `#ff8fb0` | Foco (`outline` e o anel das capas), links, passo atual |
| `--busy` | `#7cc4ff` | Em andamento (recebendo, compilando, na fila) |
| `--ok` / `--warn` / `--danger` | `#3ddc84` / `#f5a524` / `#ff4b3e` | Pronto / precisa de alguém / falhou |

Nada de brilho, degradê de fundo ou desfoque decorativo (`--glow` ficou transparente só para as regras antigas).

## Tipografia

- **Host Grotesk** (variável, 300–800) em tudo: títulos em 650, corpo em 500. Latin e latin-ext (o Ō de Ōkami),
  servidas pelo app a partir de `@fontsource-variable/host-grotesk` (OFL), sem chamada externa.
- **JetBrains Mono** (500): seriais, contadores, códigos de sala (`KRTZ`), o selo BETA.
- Unbounded e Manrope continuam servidas para `watch.html` e o overlay do jogo, que ainda não mudaram.

| Uso | Tamanho |
| --- | --- |
| Saudação ("Boa noite, Ana") | clamp(26px, 3vw, 40px) / 1,05, 650, −0,03em |
| Nome no destaque | 22 / 1,15, 650 · na gaveta 24 |
| Nome na capa | 13 (capa grande: 20 / 24) |
| Corpo / notas | 15 / 24 · 13 / 20 |
| Rótulos (`--t-xs`) | 11 / 16, 700, maiúsculas — só em blocos da gaveta e chips, nunca acima de um título |

## A parede

- Capas 2:3 de ponta a ponta, 2 px entre elas (`--gap`), sem cantos arredondados.
- A altura da linha sai da janela: **3 linhas inteiras** (2 abaixo de 620 px de altura), então nada corta no meio de
  uma capa. `--tw` é a largura da capa; `app.js` (`fit`) põe em `--cols` quantas cabem ao lado das palavras (mín. 280
  px), e a sobra da largura vai para as palavras, nunca para a capa. No celular (≤760 px): 3 colunas.
- **Ordem e tamanho** (`library.js` `arrange`, testado em `page/wall.test.js`): o destaque e os jogos com sala aberta
  em 2×2 (3 no máximo; 1 numa janela baixa), depois o que precisa de alguém (falta a BIOS, envio parado, falhou), o
  que está a caminho, e os prontos por nome. "Adicionar jogo" por último.
- **Capa:** esmaecida em repouso (brilho 62%), acesa e aproximada 3,5% em hover, foco e quando é o jogo da gaveta.
- **Placa:** o nome e o estado numa placa preta no pé da capa (27% da altura, onde a capa gerada desenha o título:
  nunca texto sobre texto, e uma capa enviada sem título continua dizendo o que é). O nome tem 1 linha em repouso e
  até 3 em hover/foco. Upload e compilação: uma linha de 2 px na emenda entre a arte e a placa, na cor do estado.
- **Estado = forma + texto**, nunca só cor: pronto ●, a caminho ○ (anel), precisa de alguém ◆, falhou ■.

## Espaço e forma

- Escala de 4: `--s1` 4 … `--s7` 48. Barra de 56 px (`--bar`); coluna das palavras com 24 px de margem.
- Raios: `--r-sm` 6 (botões, campos, chips), `--r-md` 8, `--r-lg` 12 (janelas). A parede não tem raio.
- Profundidade só no que flutua: gaveta e janelas com sombra longa e escura + contorno de 1 px.

## Movimento

- `--fast` 120 ms, `--base` 220 ms, gaveta 320 ms, `--slow` 600 ms; `--ease` `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- **Primeira olhada** (só ao abrir): as palavras sobem e a parede acende capa por capa (40 ms entre elas, até a 18ª).
- **Abrir um jogo:** a capa clicada voa e cresce até o pôster da gaveta enquanto a gaveta desliza (`app.js` `fly`).
- **Ao vivo:** o ponto de "sala aberta" e o passo atual pulsam (dado ao vivo de verdade, nada decorativo).
- `prefers-reduced-motion: reduce` → nada se move nem voa; só troca de cor.

## Componentes

- **Barra:** marca (símbolo + "HypePlay" + BETA), as seções (ícone + nome; abaixo de 1240 px só o ícone, com o nome
  no `title` e para leitor de tela; a ativa leva um traço coral de 2 px embaixo) e quem é você à direita.
- **Coluna das palavras** (fixa ao rolar): saudação e resumo; o destaque (nome do jogo, "Continuar jogando · Testado",
  texto, **Jogar agora** + sala, "Bruno abriu a sala KRTZ"); quem está por perto; e "Seus jogos" no pé.
- **Botão primário:** 42 px, coral, texto preto 700, `--r-sm`; hover `--primary-hi`. **Secundário:** sem fundo,
  contorno `--line-hi`. **Discreto:** só texto `--soft`. **Perigo:** como o secundário, texto `--danger`.
- **Gaveta:** à direita (420 px), `--side`; no topo o pôster da capa (clique troca a capa), embaixo nome, dados,
  selos e os blocos (Situação, Versão rápida, Jogar online, Jogo). Fecha com Esc, clique fora ou o X; o fundo escurece
  35%, sem desfoque. A capa do jogo aberto ganha um contorno coral na parede.
- **Foco (teclado e controle):** anel `--accent` de 3 px desenhado por cima da arte da capa, com 2 px de preto por
  dentro; nos outros elementos, `outline` de 2 px.
- **Janelas (assistente, controle, servidor):** as mesmas superfícies e botões; fundo atrás escurecido a 75%.

## Imagens e ícones

- **Logo** (`page/icon.svg`): um **H** cuja barra do meio é um botão play (Hype + Play), preto sobre o quadrado coral
  (`#ff5a8a`, chapado). Lê bem de 16 px a 1024 px.
- **Nome:** "HypePlay" em `--ink`, Host Grotesk 700 (na entrada, antes do passe, a fonte do sistema).

- **Ícones:** traço de 2 px, 24×24, cantos redondos (mesmo estilo dos de hoje, em `<symbol>` no SVG da página).
  Nada de emoji como ícone.
- **Capas:** a enviada (WebP 600×900) ou a gerada pelo servidor: um disco iridescente saindo pela borda, na cor do
  jogo (matiz de 200 a 340, do azul ao magenta, tirado do serial), com trilhas, reflexo e furo; uma lombada escura
  com o serial em mono e "PS2"; o nome embaixo com um traço da mesma cor (na parede, a placa cobre essa faixa). Nunca logos ou artes de terceiros.
  O endereço da capa muda junto com ela (versão do desenho, nome, cada capa enviada), porque fica um ano em cache.
- **Ilustrações:** "Adicionar jogo" (duas caixas em contorno e um +) e os controles da tela de mapeamento
  (`page/home/pads.js`): PS2, PS4/PS5 (analógicos lado a lado, touchpad) e Xbox (analógicos desencontrados), em SVG
  próprio, sem logos, com as cores dos tokens. Começa no desenho que o nome do controle sugere, e uma chave troca.
  Os símbolos △ ○ ✕ □ são desenhados (não texto); só as letras A B X Y do Xbox levam as cores dele (`#3ddc84`,
  `#ff5d6c`, `#5aa9ff`, `#f5c524`).
