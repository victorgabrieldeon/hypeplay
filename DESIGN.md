# CordPlay — design system

Direção: **"console à noite"**. Escuro, roxo, com cara de produto: a cor serve a ação, as capas dos jogos são o
que tem cor de verdade. Tudo vira CSS variables em `page/` (`--nome`); as páginas usam nomes, nunca valores.

> Direção tirada do CordPlay atual e das regras do skill de design, **sem comparação com sites reais** (o
> UXKIN não estava conectado).

## Cor

| Token | Valor | Papel |
| --- | --- | --- |
| `--bg` | `#0b0a14` | Fundo da página |
| `--side` | `#0f0d1a` | Lateral e gaveta |
| `--surface` | `#13111f` | Cards, caixas |
| `--surface-hi` | `#1b1830` | Campos, trilhos de barra, hover de linha |
| `--surface-top` | `#242040` | Botão secundário, chips |
| `--line` | `rgb(255 255 255 / 0.06)` | Bordas e divisórias |
| `--ink` | `#f3f2fb` | Texto principal (17,7:1 sobre `--bg`) |
| `--soft` | `#a3a1bd` | Texto secundário (7,9:1 sobre `--bg`, 7,4:1 sobre `--surface`) |
| `--faint` | `#6f6c8c` | Só ícones e ilustrações; nunca texto pequeno (3,9:1) |
| `--line-hi` | `rgb(255 255 255 / 0.1)` | Contorno de capa, campo e botão secundário |
| `--glow` | `rgb(118 85 255 / 0.45)` | Brilho do primário: sombra do botão, capa em hover, item ativo |
| `--primary` | `#7655ff` | Botões primários, item ativo da navegação, barra de progresso |
| `--primary-hi` | `#6a4af5` | Hover do primário (mais escuro: branco a 5,4:1; o mais claro ficaria em 3,6:1) |
| `--accent` | `#a08cff` | Foco (`outline`), links, passo atual, destaques pequenos |
| `--ok` | `#3ddc84` | Pronto, testado, salvo |
| `--warn` | `#f5a524` | Experimental, precisa da ISO, envio parado |
| `--danger` | `#f0384c` | Falhou, remover, erro |

Texto sobre `--primary` é sempre `#fff` (4,65:1). Degradê só nas capas geradas, no fundo do destaque e da gaveta (a
própria capa, desfocada) e em dois brilhos roxos fixos atrás da página; nada de degradê roxo→azul em botão, título
ou seção.

## Tipografia

- **Unbounded** (variável, 600–700): títulos, nome no destaque, números grandes, a marca. Larga e geométrica, com
  cara de console; só em textos curtos (nome de jogo no card fica na Manrope).
- **Manrope** (variável, 500–800): todo o resto. Corpo em 500 (o 400 fica fino demais sobre o escuro).
- **JetBrains Mono** (variável, 500): seriais (`SLUS-21678`), contadores e códigos de sala.
- Servidas pelo app a partir de `@fontsource-variable/unbounded`, `@fontsource-variable/manrope` e
  `@fontsource-variable/jetbrains-mono` (OFL), sem chamada externa. A página de entrada (antes do passe) usa a fonte
  do sistema.

| Token | Tamanho / altura | Uso |
| --- | --- | --- |
| `--t-xs` | 11 / 16, Manrope 700, maiúsculas, +0,08em | Chips, rótulos de seção, sobretítulos (+0,14em) |
| `--t-sm` | 13 / 20, Manrope 500 | Notas, metadados, estados |
| `--t-md` | 15 / 24, Manrope 500 | Corpo |
| `--t-lg` | 17 / 26, Manrope 700 | Títulos de caixa |
| `--t-xl` | 20 / 28, Unbounded 600, −0,02em | Títulos de seção e de modal |
| — | 26 / 1,2, Unbounded 600, −0,02em | Saudação no topo ("Boa noite, Ana") |
| `--t-2xl` | 30 / 36, Unbounded 600 | Números grandes (porcentagem) |
| — | clamp(28px, 3,4vw, 44px) / 1,1, Unbounded 700, −0,03em, até 18ch | Nome no destaque |

Linhas de texto até ~70 caracteres; números com `font-variant-numeric: tabular-nums`.

## Espaço

Escala de 4: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 24, `--s6` 32, `--s7` 48. Margem da página 24
(16 abaixo de 760 px); entre seções, 32. Lateral 232 px; gaveta 380 px.

## Forma e profundidade

- Raios: `--r-sm` 8 (botões, campos, chips), `--r-md` 12 (cards, capas), `--r-lg` 18 (destaque, modal, gaveta).
- Bordas de 1 px em `--line` no lugar de sombra no que fica no plano.
- Sombra do que flutua (overlay): `--lift: 0 18px 40px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.06)`.
  Modal, gaveta e destaque têm sombra própria, mais longa e escura.
- Brilho roxo (`--glow`) só no que é da marca e responde: botão primário, capa em hover, item ativo, barra de
  progresso.
- Fundo atrás de modal e gaveta: escurecido e desfocado (4–6 px).

## Movimento

- Durações: `--fast` 120 ms (hover, foco), `--base` 220 ms (modal), 320 ms (gaveta), `--slow` 600 ms (intro,
  brilho, zoom da capa).
- Curvas: `--ease` `cubic-bezier(0.2, 0.8, 0.2, 1)` para tudo; `--spring` `cubic-bezier(0.34, 1.56, 0.64, 1)` só em
  ícones (passa um pouco e volta).
- **Primeira olhada** (só ao abrir; as atualizações a cada 2 s não animam): o destaque sobe linha a linha, a capa
  entra girando para o lugar, os cards sobem um depois do outro (45 ms entre eles, até o 12º).
- **Destaque:** o fundo desfocado deriva devagar (26 s, vai e volta); a capa flutua 10 px (7 s) e se endireita em
  hover.
- **Capa em hover:** sobe 6 px com brilho roxo, a imagem aproxima 6% e um brilho diagonal atravessa uma vez.
- **Carregando:** formas do que vem (destaque e capas) com brilho passando, no lugar de "Carregando…".
- **Ao vivo:** o ponto de "sala aberta" e de estado ocupado pulsa um anel.
- **Adicionar jogo:** as duas caixas em contorno se abrem em leque e o + gira.
- Upload: barra com listras andando; a seta da área de soltar flutua.
- `prefers-reduced-motion: reduce` → nada se move; só troca de cor.

## Componentes

- **Botão primário:** 40 px, `--primary`, texto branco 600, `--r-sm`; hover `--primary-hi`; ativo desce 1 px;
  foco `outline: 2px solid var(--accent)` com 2 px de folga; desabilitado 50% e sem hover.
- **Botão secundário:** `--surface-top`, texto `--ink`. **Discreto:** sem fundo, texto `--soft`, hover `--ink`.
- **Perigo:** como o secundário, texto `--danger`; a ação real pede confirmação.
- **Campo:** 40 px, `--surface-hi`, borda `--line`, foco com borda `--accent`.
- **Card de jogo:** capa 2:3 (`--r-md`), nome em Manrope 700 14 px abaixo, e embaixo dele o serial (mono) ou as
  salas abertas. Jogo pronto não leva selo na capa: só o que pede atenção (enviando, parado, falta a BIOS, falhou)
  aparece, numa pílula escura no canto. O estado é um ponto colorido + texto (nunca só cor). "Experimental" fica no
  destaque, na gaveta e no assistente, não em cada card.
- **Selo:** `--t-xs`, `--r-sm`, fundo da cor do papel a 16% e texto na cor cheia ("Testado" `--ok`,
  "Experimental" `--warn`).
- **Navegação lateral:** itens de 40 px, ícone + texto, ativo com fundo `--primary` a 18% e barra de 3 px
  `--primary` à esquerda.
- **Gaveta:** à direita, `--side`, `--lift`; fecha com Esc, clique fora ou o X.
- **Modal (assistente):** 560 px no máximo, foco preso dentro; os passos são uma barra segmentada com o nome de cada
  um embaixo (feito `--accent`, atual `--primary` com brilho). Aviso em caixa âmbar (`.callout`).
- **Topo:** sobretítulo "Biblioteca", saudação pela hora ("Bom dia / Boa tarde / Boa noite, Ana") e um resumo
  (jogos no servidor, salas abertas agora).
- **Barra de progresso:** 8 px, trilho `--surface-hi`, preenchimento `--primary`.

## Imagens e ícones

- **Ícones:** traço de 2 px, 24×24, cantos redondos (mesmo estilo dos de hoje, em `<symbol>` no SVG da página).
  Nada de emoji como ícone.
- **Capas:** a enviada (WebP 600×900) ou a gerada pelo servidor: um disco iridescente saindo pela borda, na cor do
  jogo (matiz de 200 a 340, do azul ao magenta, tirado do serial), com trilhas, reflexo e furo; uma lombada escura
  com o serial em mono e "PS2"; o nome embaixo com um traço da mesma cor. Nunca logos ou artes de terceiros.
  O endereço da capa muda junto com ela (versão do desenho, nome, cada capa enviada), porque fica um ano em cache.
- **Ilustrações:** "Adicionar jogo" (duas caixas em contorno e um +) e o controle de PS2 (no mapeamento e flutuando
  enquanto espera um controle), em SVG próprio, com as cores dos tokens.
