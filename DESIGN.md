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
| `--faint` | `#6f6c8c` | Só texto grande ou ícones decorativos (3,9:1) |
| `--primary` | `#7655ff` | Botões primários, item ativo da navegação, barra de progresso |
| `--primary-hi` | `#6a4af5` | Hover do primário (mais escuro: branco a 5,4:1; o mais claro ficaria em 3,6:1) |
| `--accent` | `#a08cff` | Foco (`outline`), links, passo atual, destaques pequenos |
| `--ok` | `#3ddc84` | Pronto, testado, salvo |
| `--warn` | `#f5a524` | Experimental, precisa da ISO, envio parado |
| `--danger` | `#f0384c` | Falhou, remover, erro |

Texto sobre `--primary` é sempre `#fff` (4,65:1). Degradê só nas capas geradas e no fundo do destaque (a
própria capa, desfocada); nada de degradê roxo→azul em botão, título ou seção.

## Tipografia

- **Space Grotesk** (variável, 500–700): títulos, números grandes, a marca.
- **Inter** (variável, 400–600): todo o resto.
- Servidas pelo app a partir de `@fontsource-variable/space-grotesk` e `@fontsource-variable/inter` (OFL),
  sem chamada externa.

| Token | Tamanho / altura | Uso |
| --- | --- | --- |
| `--t-xs` | 11 / 16, 600, maiúsculas, +0,06em | Chips, rótulos de seção |
| `--t-sm` | 13 / 20 | Notas, metadados, estados |
| `--t-md` | 15 / 24 | Corpo |
| `--t-lg` | 17 / 26, 600 | Títulos de caixa, nome na gaveta |
| `--t-xl` | 22 / 28, Space Grotesk 600 | Título de página |
| `--t-2xl` | 30 / 36, Space Grotesk 700 | Números grandes (porcentagem) |
| `--t-3xl` | clamp(30px, 4vw, 46px) / 1,05, Space Grotesk 700, −0,02em | Nome no destaque |

Linhas de texto até ~70 caracteres; números com `font-variant-numeric: tabular-nums`.

## Espaço

Escala de 4: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 24, `--s6` 32, `--s7` 48. Margem da página 24
(16 abaixo de 760 px); entre seções, 32. Lateral 232 px; gaveta 380 px.

## Forma e profundidade

- Raios: `--r-sm` 8 (botões, campos, chips), `--r-md` 12 (cards, capas), `--r-lg` 18 (destaque, modal, gaveta).
- Bordas de 1 px em `--line` no lugar de sombra no que fica no plano.
- Uma sombra só, para o que flutua (modal, gaveta, overlay, capa em hover):
  `--lift: 0 18px 40px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.06)`.

## Movimento

- Durações: `--fast` 120 ms (hover, foco), `--base` 220 ms (gaveta, modal), `--slow` 600 ms (intro, brilho).
- Curva: `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Capa em hover: sobe 4 px, `--lift`, e um brilho diagonal atravessa uma vez.
- Compilação: barra com listras andando; o passo atual com um ponto pulsando.
- `prefers-reduced-motion: reduce` → sem translação, sem brilho, sem listras; só troca de cor.

## Componentes

- **Botão primário:** 40 px, `--primary`, texto branco 600, `--r-sm`; hover `--primary-hi`; ativo desce 1 px;
  foco `outline: 2px solid var(--accent)` com 2 px de folga; desabilitado 50% e sem hover.
- **Botão secundário:** `--surface-top`, texto `--ink`. **Discreto:** sem fundo, texto `--soft`, hover `--ink`.
- **Perigo:** como o secundário, texto `--danger`; a ação real pede confirmação.
- **Campo:** 40 px, `--surface-hi`, borda `--line`, foco com borda `--accent`.
- **Card de jogo:** capa 2:3 (`--r-md`), nome em `--t-md` 600 abaixo, estado em `--t-sm`. O estado é um ponto
  colorido + texto (nunca só cor).
- **Selo:** `--t-xs`, `--r-sm`, fundo da cor do papel a 16% e texto na cor cheia ("Testado" `--ok`,
  "Experimental" `--warn`).
- **Navegação lateral:** itens de 40 px, ícone + texto, ativo com fundo `--primary` a 18% e barra de 3 px
  `--primary` à esquerda.
- **Gaveta:** à direita, `--side`, `--lift`; fecha com Esc, clique fora ou o X.
- **Modal (assistente):** 560 px no máximo, passos numerados no topo, foco preso dentro.
- **Barra de progresso:** 8 px, trilho `--surface-hi`, preenchimento `--primary`.

## Imagens e ícones

- **Ícones:** traço de 2 px, 24×24, cantos redondos (mesmo estilo dos de hoje, em `<symbol>` no SVG da página).
  Nada de emoji como ícone.
- **Capas:** a enviada (WebP 600×900) ou a gerada pelo servidor: fundo `--bg`, duas formas geométricas
  grandes cortadas pela borda em degradê roxo (`--primary` → `--accent`) com variação de matiz pelo serial, e
  o nome do jogo em Space Grotesk embaixo. Nunca logos ou artes de terceiros.
- **Ilustrações:** biblioteca vazia (uma pilha de capas em contorno) e o controle da tela de mapeamento, em SVG
  próprio, com as cores dos tokens.
