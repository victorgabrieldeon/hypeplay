/**
 * Player 2's way into a room (watch.ts), step by step, and what to tell them when it stops at one: a page that just
 * spins says nothing about why. `browser`: inside Discord, opening the page in the browser is the way out.
 *
 *   start    the connection itself (the ICE servers, WebRTC): a window that doesn't allow WebRTC stops here
 *   joining  telling the host, through the server
 *   waiting  the host's game answering (its page has to be open, with the room)
 *   linking  the picture's connection between the two networks (without a TURN, some never meet)
 */
export type Step = "start" | "joining" | "waiting" | "linking";

export function stuckAt(step: Step, error?: string): { title: string; text: string; browser: boolean } {
  const why = error ? ` (${error})` : "";
  switch (step) {
    case "start":
      return { title: "Não deu para preparar a conexão", text: `Esta janela não deixou abrir a conexão de vídeo${why}. Abra no navegador.`, browser: true };
    case "joining":
      return { title: "O servidor não respondeu", text: `Não deu para avisar o host${why}. Tente de novo.`, browser: false };
    case "waiting":
      return {
        title: "O host não respondeu",
        text: `A sala existe, mas o jogo do host não respondeu${why}. Ele precisa estar com o jogo aberto, com a sala.`,
        browser: false,
      };
    case "linking":
      return {
        title: "Sem conexão com o host",
        text: `As redes de vocês não se alcançaram${why}. O servidor precisa de um TURN (TURN_URL e TURN_SECRET). No navegador às vezes passa.`,
        browser: true,
      };
  }
}
