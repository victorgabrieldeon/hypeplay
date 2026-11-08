# Briefing da rodada 2 (vale junto com BRIEF.md — o que estiver aqui ganha)

O usuário rejeitou a rodada 1 inteira (mundos temáticos: locadora, revista, caderno, CD-R, fliperama…). Ele quer:
**escuro, um pouco minimalista, com a qualidade de launcher grande (referência: bibliotecas da Steam e da Epic Games),
mas com identidade própria do HypePlay.**

## O que isso significa
- Produto sério, nível launcher. Nada de metáfora/fantasia/skeuomorfismo. A identidade vem dos detalhes precisos:
  a tipografia, UM acento, o símbolo H-play, o ritmo do espaço, a forma dos estados, o movimento.
- Escuro de verdade, paleta contida (neutros com um leve tom próprio + um acento + as 4 cores de estado). As capas
  são o que tem cor.
- Referência ≠ cópia: não usar o azul da Steam (#1b2838 / #66c0f4), nem o layout exato da Epic ou da Steam, nem
  logos/ícones deles. Pegue os padrões que funcionam (lista lateral + painel, banner de destaque, fileiras de
  capas, barra de atividade de amigos, filtros) e dê uma cara própria.
- Continua proibido: preto + neon com brilho, glass decorativo, texto em degradê, eyebrow acima de título, borda
  colorida grossa na lateral, emoji/Unicode como ícone, cards iguais de ícone+título+texto.
- Contraste ≥4,5:1. Tema seleção, scrollbar e foco. Estado = ponto/forma + texto (nunca só cor).
- Mesmo conteúdo (`conteudo.md`), mesmas capas (`capas/*.svg`), mesma viewport 1280×720, mesmas regras de
  verificação headless e o mesmo relatório (tese, paleta, fontes, layout, risco, custo). Saída:
  `docs/estilos/NN-slug.html` com NN de 11 a 20. Não edite outros arquivos, não rode git.
- O destaque pode usar a própria capa ampliada/desfocada como fundo (é o que os launchers fazem), mas com
  contenção: um momento, não a página toda brilhando.
- Hover e foco têm que ser bonitos e calmos (é aí que um launcher mostra acabamento): faça os dois de verdade no CSS.
