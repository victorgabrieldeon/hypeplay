# Briefing comum (para quem constrói cada estilo)

Projeto: HypePlay — central de jogos de PS2 que roda como atividade do Discord (amigos numa call de voz, à noite,
no Brasil). Alguém envia a ISO uma vez, o servidor prepara, e todo mundo da call joga ou entra numa sala online
(código de 4 letras). Também funciona no navegador, no app de PC e com controle (navegação por gamepad).
Superfície: a HOME (biblioteca). Modo **Operate**: o estado de cada jogo precisa ser legível de relance, mesmo nos
estilos mais barulhentos. Cada estilo é uma direção NOVA de design system + layout (redesenho, não polimento do atual).

## Regras duras
- Saída: só `docs/estilos/NN-slug.html` (um arquivo por estilo). Não edite nada fora de `docs/estilos/`. Não rode git
  (outras sessões commitam nesta worktree).
- Arquivo autocontido: CSS e SVG inline. Google Fonts por `<link>` pode (é exploração). Capas: `capas/*.svg`
  (relativo ao HTML) — são as capas reais geradas pelo servidor; use-as. Pode tratar/emoldurar as capas no idioma do
  estilo (estojo, envelope, etiqueta…), mas nunca invente arte/logos de terceiros.
- Conteúdo: EXATAMENTE o de `docs/estilos/conteudo.md` (leia). Português com acentos.
- Viewport 1280×720; a primeira tela tem que conter nav, saudação, destaque com "Jogar agora" + sala KRTZ, e o começo da
  grade. Responsivo básico (até ~390 px) é bom, mas não prioridade.
- O layout muda de verdade conforme o mundo (prateleira, carrossel, painel, página…); não é o mesmo layout recolorido.
- Proibido (craft floor): sobretítulo/eyebrow acima de título; texto em degradê; emoji ou glifo Unicode como ícone
  (△○✕□ das dicas de controle são SVG desenhado); borda colorida grossa à esquerda/direita em cards/listas; sombra dura
  deslocada sem blur (a não ser que o mundo seja realmente brutalista); glass/blur decorativo; cards iguais de
  ícone+título+texto como estrutura; preto quase puro + um neon com brilho como atalho de "gamer".
- Fontes: evite Inter, Space Grotesk, Space Mono, IBM Plex, DM Sans, Outfit, Plus Jakarta, Syne, Fraunces, Playfair.
  Mono só para dados de verdade (serial, código de sala, porcentagem).
- Contraste ≥4,5:1 no texto. Foco visível (um card em foco, Ōkami). Tema também seleção de texto e scrollbar.
- Ícones: SVG desenhado num traço consistente.

## Verificação (obrigatória, headless — NUNCA capture a tela do usuário)
```
H=~/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell
$H --no-sandbox --hide-scrollbars --virtual-time-budget=4000 --window-size=1280,720 \
   --screenshot=/tmp/estilos/NN.png file:///home/victor/code/pessoal/bt3/docs/estilos/NN-slug.html
```
Abra o PNG (Read) e corrija o que estiver quebrado (texto vazando, fonte não carregada, capa faltando, contraste).
Faça no máximo 2–3 rodadas.

## O que devolver (por estilo, curto, em português)
- **Tese** (1 linha) · **Paleta** (hex + papel) · **Fontes** · **O que muda no layout** vs. a home atual
  (lateral 232 px + destaque + grade de capas 2:3) · **Risco honesto** · **Custo de implementar** (o que muda em
  `page/index.html` CSS, `page/home/library.js`, `drawer.js`, `gamepadnav.js`).
