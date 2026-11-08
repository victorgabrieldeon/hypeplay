# Conteúdo fixo das 10 direções

Toda direção mostra **exatamente** este conteúdo (mesmos textos, mesmos estados), para dar para comparar. Dados de
exemplo: nomes de pessoas e números são inventados.

## Moldura

- Viewport 1280×720 (o quadro de uma atividade do Discord ou de uma TV). A página não rola na primeira tela;
  pode rolar para mostrar o resto da grade.
- Marca: **HypePlay** + o símbolo "H cuja barra do meio é um botão play" (`page/icon.svg`; pode recolorir e
  redesenhar o traço no estilo, sem perder a ideia). Selo "BETA" opcional.

## Navegação (nesta ordem)

1. Biblioteca (ativa) — contador `7`
2. Pessoas — contador `3`
3. Adicionar jogo
4. Controle
5. Servidor
6. Abrir no navegador
7. App para PC

## Topo

- Saudação: **Boa noite, Ana**
- Resumo: **7 jogos no servidor · 2 salas abertas agora**
- Quem está na call (avatar = inicial em círculo, cor por pessoa): Ana (você, "Na biblioteca"), Bruno ("Jogando
  Dragon Ball Z: Budokai Tenkaichi 3"), Carla ("Assistindo Dragon Ball Z: Budokai Tenkaichi 3")

## Destaque

- Rótulo do bloco: **Continuar jogando**
- Jogo: **Dragon Ball Z: Budokai Tenkaichi 3** · `SLUS-21678` · selo **Testado**
- Texto: **Adicionado por Bruno. A ISO fica no servidor: é só jogar.**
- Botão primário: **Jogar agora** · secundário: **Abrir uma sala**
- Sala aberta: código **KRTZ** · Bruno jogando · **Vaga de jogador 2** · botão **Entrar como jogador 2**

## Seus jogos (título da seção) — "Enviados uma vez, para todo mundo"

| Capa (`capas/`) | Nome | Serial | Estado (ponto colorido + texto, nunca só cor) |
| --- | --- | --- | --- |
| `bt3.svg` | Dragon Ball Z: Budokai Tenkaichi 3 | SLUS-21678 | Pronto · **1 sala aberta** |
| `naruto.svg` | Naruto: Ultimate Ninja 2 | SLUS-21410 | **Recebendo 62%** (barra de progresso) |
| `gt4.svg` | Gran Turismo 4 | SCUS-97328 | **Compilando 3/5** (passo: "Extraindo os dados") |
| `okami.svg` | Ōkami | SLUS-21115 | **Falta a BIOS** (atenção) |
| `burnout.svg` | Burnout 3: Takedown | SLUS-21050 | **Envio parado em 41%** (atenção) |
| `sotc.svg` | Shadow of the Colossus | SCUS-97472 | **Falhou** (erro) — "A compilação falhou." |
| `pes.svg` | Winning Eleven 9 | SLUS-21326 | Pronto · **1 sala aberta** |
| — | **Adicionar jogo** (card vazio, chama o assistente) | | |

Jogo pronto não leva selo na capa; só o que pede atenção. "Experimental" aparece no destaque/gaveta, não nos cards.

## Foco de controle

Um card (Ōkami) aparece em **estado de foco** (a navegação por controle existe: `page/home/gamepadnav.js`).
Dicas de controle no rodapé, quando o estilo usar: **✕ Abrir · △ Sala · ○ Voltar** — os símbolos desenhados em
SVG, nunca texto/Unicode.
