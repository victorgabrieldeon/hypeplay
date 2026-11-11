# HypePlay — design system

Direção: **"Vitrine"** (desde 2026-11-11, a partir de um mock aprovado; antes era o "Mosaico", em `docs/estilos/`).
Escuro com um leve tom de ameixa, coral como acento: uma coluna lateral (quem é você, as seções, o servidor e
"Jogar agora"), uma barra de abas no topo, um banner que gira pelos destaques e a biblioteca em cards arredondados com
filtros em pílula. As capas continuam sendo o que tem cor. Tudo vira CSS variables em `page/index.html` (`--nome`); as
páginas usam nomes, nunca valores. A moldura (banner, filtros, busca, grade/lista, coluna lateral) é `page/home/shell.js`.

## Cor

| Token | Valor | Papel |
| --- | --- | --- |
| `--bg` | `#0a0a0f` | Fundo da página |
| `--side` | `#110d16` | Coluna lateral, gaveta, janelas |
| `--surface` | `#16131d` | Cards, pílulas, caixas, campos |
| `--surface-hi` | `#1e1a27` | Hover de linha, de item e de caixa |
| `--surface-top` | `#2a2533` | Contadores, chips |
| `--tint` / `--tint-line` | coral a 16% / 38% | Item ativo da coluna e aba ativa (fundo / contorno) |
| `--line` / `--line-hi` | branco a 8% / 14% | Divisórias / contorno de botão secundário, campo e gaveta |
| `--ink` | `#f4f2f3` | Texto principal |
| `--soft` | `#a6a2a4` | Texto secundário (≥7:1 sobre o preto) |
| `--faint` | `#6b6869` | Só ícones e ilustrações; nunca texto |
| `--primary` | `#fa5c86` | Coral: botão primário, seção ativa, a capa da gaveta aberta, barra de progresso, seleção de texto |
| `--primary-hi` | `#ff7aa1` | Hover do primário |
| `--on-primary` | `#000` | Texto sobre o coral (o branco não passa de 3:1) |
| `--accent` | `#ff8fb0` | Foco (`outline` e o anel das capas), links, passo atual |
| `--busy` | `#7cc4ff` | Em andamento (recebendo, compilando, na fila) |
| `--ok` / `--warn` / `--danger` | `#45e283` / `#f5a524` / `#ff4b3e` | Pronto / precisa de alguém / falhou |

Degradês só de ambiente e sempre do coral para o fundo: o brilho no pé da coluna lateral, o cartão da saudação e o lado
esquerdo do banner (que escurece a arte para o texto). Nada de degradê em texto ou botão.

## Tipografia

- **Host Grotesk** (variável, 300–800) em tudo: títulos em 650, corpo em 500. Latin e latin-ext (o Ō de Ōkami),
  servidas pelo app a partir de `@fontsource-variable/host-grotesk` (OFL), sem chamada externa.
- **JetBrains Mono** (500): seriais, contadores, códigos de sala (`KRTZ`), o selo BETA.
- Unbounded e Manrope continuam servidas só para `watch.html`, que ainda não mudou. O painel do jogo (`overlay.ts`) e a
  barra do PS2 (`ps2play.ts`) ainda são Mosaico (preto puro) e carregam a Host Grotesk da pasta `fonts/` da biblioteca.

| Uso | Tamanho |
| --- | --- |
| Saudação ("Boa noite, Ana") | clamp(26px, 3vw, 40px) / 1,05, 650, −0,03em |
| Nome no destaque | 22 / 1,15, 650 · na gaveta 24 |
| Nome na capa | 13 (capa grande: 20 / 24) |
| Corpo / notas | 15 / 24 · 13 / 20 |
| Rótulos (`--t-xs`) | 11 / 16, 700, maiúsculas — só em blocos da gaveta e chips, nunca acima de um título |

## A biblioteca

- **Banner** (`shell.js`): o destaque (o último jogo da pessoa, senão o primeiro pronto), depois jogos com sala aberta,
  favoritos e outros prontos, 5 no máximo. A capa entra pela direita, esmaecida para a esquerda; o texto fica em cima do
  escuro: plataforma e selo, nome, por que está ali, **Jogar agora** + Detalhes (abre a gaveta) + online + favoritar.
  Setas e pontos; gira a cada 8 s só se ninguém estiver com o ponteiro ou o foco nele, e nunca com movimento reduzido.
- **Cabeçalho:** "Minha biblioteca", os filtros em pílula (Todos, Prontos, Favoritos, Com sala aberta, Precisam de
  você; um filtro vazio não aparece) com a contagem, e a chave grade/lista (lembrada neste navegador). A lupa da barra
  abre a busca por nome (sem acento), que filtra os cards na hora.
- **Cards:** grade `auto-fill` de no mínimo 178 px, 22 px entre eles, 3:4, raio 14, contorno de 1 px; selo "PS2" no
  canto; o nome (até 2 linhas) e o estado no pé, sobre um degradê que fica opaco onde o texto está (a capa gerada
  desenha o título ali: nunca texto sobre texto). Hover e foco: sobe 3 px e a arte cresce 4%. A ordem continua a de
  `library.js` `arrange` (testada em `page/wall.test.js`), mas todos os cards têm o mesmo tamanho. "Adicionar jogo" por
  último, tracejado. Na lista: uma linha de 76 px por jogo, capa pequena no início.
- **Estado = forma + texto**, nunca só cor: pronto ●, a caminho ○ (anel), precisa de alguém ◆, falhou ■. Upload:
  a linha de 2 px na emenda do pé.

## Espaço e forma

- Escala de 4: `--s1` 4 … `--s7` 48. Barra de 56 px (`--bar`); coluna das palavras com 24 px de margem.
- Raios: `--r-sm` 6 (botões, campos, chips), `--r-md` 8, `--r-lg` 12 (janelas); cards 14, banner e cartão da saudação 18–20, pílulas redondas.
- Profundidade só no que flutua: gaveta e janelas com sombra longa e escura + contorno de 1 px.

## Movimento

- `--fast` 120 ms, `--base` 220 ms, gaveta 320 ms, `--slow` 600 ms; `--ease` `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- **Primeira olhada** (só ao abrir): a coluna e a biblioteca sobem e os cards acendem um por um (40 ms entre elas, até a 18ª).
- **Abrir um jogo:** a capa clicada voa e cresce até o pôster da gaveta enquanto a gaveta desliza (`app.js` `fly`).
- **Ao vivo:** o ponto de "sala aberta" e o passo atual pulsam (dado ao vivo de verdade, nada decorativo).
- `prefers-reduced-motion: reduce` → nada se move nem voa; só troca de cor.

## Componentes

- **Coluna lateral** (272 px, fixa ao rolar): marca; o cartão da saudação ("Boa noite, Ana" e o resumo); as seções
  (Biblioteca com o total, Downloads com o que está chegando do vimm.net, Servidor, Amigos, Controle, Adicionar jogo),
  a ativa em `--tint` com contorno `--tint-line`; quem está por perto (friends.js); o status do servidor (`/health`,
  medido a cada 15 s, com o tempo de resposta); e **Jogar agora** no pé, que abre o destaque.
- **Barra do topo** (72 px): as abas Início, Biblioteca, Explorar (a loja) e Amigos (ícone + nome; a ativa em `--tint`
  com um traço coral embaixo) e, à direita, a busca, o sino (só com amigos; ponto coral quando há convite ou pedido),
  o Servidor e você.
- Abaixo de 860 px a coluna lateral vem antes, sem fixar, com as seções em uma linha que rola; as abas ficam só ícone.
- **Botão primário:** 42 px, coral, texto preto 700, `--r-sm`; hover `--primary-hi`. **Secundário:** sem fundo,
  contorno `--line-hi`. **Discreto:** só texto `--soft`. **Perigo:** como o secundário, texto `--danger`.
- **Gaveta:** à direita (420 px), `--side`; no topo o pôster da capa (clique troca a capa), embaixo nome, dados,
  selos e os blocos (Situação, Versão rápida, Jogar online, Jogo). Fecha com Esc, clique fora ou o X; o fundo escurece
  35%, sem desfoque. O card do jogo aberto ganha um contorno coral.
- **Foco (teclado e controle):** anel `--accent` de 3 px desenhado por cima da arte da capa, com 2 px de preto por
  dentro; nos outros elementos, `outline` de 2 px.
- **Configurações no jogo** (`overlay.ts`): o botão no canto abre uma coluna à direita (380 px, `--side`), como a
  gaveta e os Amigos (Shift+Tab), sem escurecer o jogo. Abas como a barra da biblioteca (a escolhida em `--ink` com o
  traço coral embaixo; setas trocam): **Vídeo · Áudio · CPU · Sistema · Multiplayer**; aba sem nada não aparece (CPU e
  Sistema só existem no PS2, `perf.ts`). Dentro, seções com rótulo `--t-xs` entre linhas finas; cada opção é um grupo
  segmentado (a escolha em coral com texto preto) com uma dica `--soft`. As opções do PCSX2 ficam em "Ao abrir o jogo"
  de cada aba, com "Voltar ao padrão"; o que só vale ao reabrir mostra no rodapé a nota de contorno coral com
  **Reabrir agora**. Para acrescentar uma opção do PCSX2: uma entrada em `BOOT` (`perf.ts`), com a aba dela.
- **Janelas (assistente, controle, servidor):** as mesmas superfícies e botões; fundo atrás escurecido a 75%.

## Imagens e ícones

- **Logo** (`page/icon.svg`): um **H** cuja barra do meio é um botão play (Hype + Play), preto sobre o quadrado coral
  (`#ff5a8a`, chapado). Lê bem de 16 px a 1024 px.
- **Nome:** "HypePlay" em `--ink`, Host Grotesk 700 (na entrada, antes do passe, a fonte do sistema).

- **Ícones:** traço de 2 px, 24×24, cantos redondos (mesmo estilo dos de hoje, em `<symbol>` no SVG da página).
  Nada de emoji como ícone.
- **Capas:** a enviada (WebP 600×900) ou a gerada pelo servidor: um disco iridescente saindo pela borda, na cor do
  jogo (matiz de 200 a 340, do azul ao magenta, tirado do serial), com trilhas, reflexo e furo; uma lombada escura
  com o serial em mono e "PS2"; o nome embaixo com um traço da mesma cor (no card, o degradê do pé cobre essa faixa). Nunca logos ou artes de terceiros.
  O endereço da capa muda junto com ela (versão do desenho, nome, cada capa enviada), porque fica um ano em cache.
- **Ilustrações:** "Adicionar jogo" (duas caixas em contorno e um +) e os controles da tela de mapeamento
  (`page/home/pads.js`): PS2, PS4/PS5 (analógicos lado a lado, touchpad) e Xbox (analógicos desencontrados), em SVG
  próprio, sem logos, com as cores dos tokens. Começa no desenho que o nome do controle sugere, e uma chave troca.
  Os símbolos △ ○ ✕ □ são desenhados (não texto); só as letras A B X Y do Xbox levam as cores dele (`#3ddc84`,
  `#ff5d6c`, `#5aa9ff`, `#f5c524`).
