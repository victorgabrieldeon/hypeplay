# Briefing da rodada 3 — variações do Mosaico (vale junto com BRIEF.md e BRIEF-2.md; o que estiver aqui ganha)

O usuário escolheu o **19 Mosaico** (`docs/estilos/19-mosaico.html`). Leia esse arquivo inteiro: ele é a base.
Agora exploramos variações dele. O MUNDO fica fixo:
- parede de capas 2:3 de ponta a ponta (vão de 2 px), capas esmaecidas em repouso e acesas em hover/foco;
- barra fina flutuante no topo; painel lateral do jogo (a não ser que a variação mexa justamente nele);
- preto de cinema, acento coral `#ff5a8a` contido (texto preto sobre ele), Host Grotesk + JetBrains Mono;
- estados com forma + texto; dicas ✕ △ ○ em SVG; marca H-play.
Cada variação mexe num EIXO só (dito no pedido) e mantém o resto. Pode copiar o CSS/HTML do 19 como ponto de
partida.

## Defeitos da base que toda variação corrige
1. As etiquetas de estado no canto de cima cobrem a faixa do serial/"PS2" que a capa gerada desenha no topo. Mova as
   etiquetas para outro lugar (ex.: embaixo, sobre a área do nome, ou ancoradas fora da arte) ou cubra a faixa de
   propósito — mas nada de texto por cima de texto.
2. O painel fica com um vão vazio enorme no meio. Ocupe com conteúdo real e útil (ex.: quem da call está nesse jogo,
   a sala, "Experimental"/"Testado", tamanho/serial/quem adicionou, ações secundárias como "Trocar a capa"), ou
   encolha o painel — sem inventar números/fatos que não estejam no conteudo.md (pode usar os textos que o app já
   tem: "Trocar a capa", "Remover", "Jogar online", "Abrir uma sala", "Entrar na sala", "Jogador 2 ocupado").
3. Na primeira tela a última linha da parede corta no meio de uma capa: cuide do corte (a altura da linha pode
   derivar do viewport, ou o corte cai num lugar intencional).

Saída: `docs/estilos/19x-slug.html` (x = letra dada no pedido). Mesma verificação headless (1280×720) e o mesmo
relatório curto (tese da variação, o que mudou vs. o 19, risco, custo). Não edite outros arquivos; não rode git.
Capas extras para biblioteca grande: `docs/estilos/capas/extra/` (lista em `LISTA.md`, seriais inventados).
