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

/**
 * Where player 2's page is: inside Discord (framed), on Discord's own address in a browser tab (the link "Abrir no
 * navegador" gives when the server has no PUBLIC_URL; Discord takes WebRTC away there too), or the server's address.
 */
export type Where = "discord" | "discord-site" | "browser";
export const whereAmI = (framed: boolean, host: string): Where =>
  framed ? "discord" : /(^|\.)discordsays\.com$/.test(host) ? "discord-site" : "browser";

/**
 * The server's TURN, for this browser: none offered (the ICE servers from ../ice), offered but no relay candidate came
 * (coturn down, or its ports closed), or answered (a relay candidate in this side's description).
 */
export type Turn = "none" | "silent" | "answered";
export function turnState(ice: { urls: string | string[] }[], sdp: string): Turn {
  if (!ice.some((s) => [s.urls].flat().some((u) => /^turns?:/.test(u)))) return "none";
  return / typ relay( |$)/m.test(sdp) ? "answered" : "silent";
}

export function stuckAt(step: Step, error?: string, where: Where = "discord", turn: Turn = "none"): { title: string; text: string; browser: boolean } {
  const why = error ? ` (${error})` : "";
  switch (step) {
    case "start":
      if (where === "discord-site")
        return {
          title: "O endereço do Discord bloqueia o vídeo",
          text: `Esta página está no endereço do Discord (discordsays.com), que bloqueia a conexão de vídeo mesmo no navegador${why}. Entre pelo endereço do servidor: quem cuida dele precisa configurar o PUBLIC_URL.`,
          browser: false,
        };
      if (where === "browser")
        return { title: "Não deu para preparar a conexão", text: `Este navegador não deixou abrir a conexão de vídeo${why}. Use um Chrome ou Edge atualizado.`, browser: false };
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
      if (turn === "silent")
        return {
          title: "O TURN do servidor não respondeu",
          text: `O servidor tem um TURN, mas ele não respondeu a este navegador${why}. Quem cuida do servidor precisa conferir se o coturn está rodando e se as portas 3478 (UDP e TCP) e 49160 a 49200 (UDP) estão abertas no firewall.`,
          browser: false,
        };
      if (turn === "answered")
        return {
          title: "Sem conexão com o host",
          text: `Nem pelo TURN as redes de vocês se alcançaram${why}. Tente de novo; se continuar, o host fecha e abre a sala.`,
          browser: false,
        };
      return {
        title: "Sem conexão com o host",
        text: `As redes de vocês não se alcançaram${why}. Quem cuida do servidor precisa ligar um TURN, o retransmissor do online (TURN_URL e TURN_SECRET).${where === "discord" ? " No navegador às vezes passa." : ""}`,
        browser: where === "discord",
      };
  }
}
