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
 * The TURN ../ice gave, for this browser: none offered, offered but no relay candidate came (this network blocks it,
 * or Cloudflare's is down), or answered (a relay candidate in this side's description).
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
          title: "O TURN não respondeu",
          text: `Tem um TURN, mas este navegador não conseguiu passar por ele${why}. Uma rede que só deixa passar web (empresa, escola) faz isso: tente outra rede.`,
          browser: false,
        };
      if (turn === "answered")
        return {
          title: "Sem conexão com o host",
          text: `Nem pelo TURN as redes de vocês se alcançaram${why}. Tente de novo; se continuar, o host fecha e abre a sala, ou um dos dois troca de rede (um Wi-Fi no lugar do 4G).`,
          browser: false,
        };
      return {
        title: "Sem conexão com o host",
        text: `As redes de vocês não se alcançaram${why}. Quem cuida do servidor precisa ligar um TURN, o retransmissor do online (TURN_CF_KEY_ID e TURN_CF_TOKEN).${where === "discord" ? " No navegador às vezes passa." : ""}`,
        browser: where === "discord",
      };
  }
}

/** How long an offered WebRTC link may take before player 2 goes by the server instead (relayguest.ts). */
export const LINK_MS = 6000;

/**
 * Whether player 2 goes by the server's relay now: at once without WebRTC; once linked, never; failed, or not linked
 * LINK_MS after the host's offer came, now; before the offer (or within those 6 s), it waits.
 */
export function relayWhen(s: { webrtc: boolean; offerAt: number | null; now: number; state: string | null }, noRelay = false): "now" | "wait" | "stay" {
  // (NO_RELAY, online.ts: never)
  if (noRelay) return "stay";
  if (!s.webrtc) return "now";
  if (s.state === "connected") return "stay";
  if (s.state === "failed") return "now";
  if (s.offerAt === null) return "wait";
  return s.now - s.offerAt >= LINK_MS ? "now" : "wait";
}

/** No relay, and the host's page has no WebRTC (it's inside Discord): what player 2 hears. */
export function hostNoP2p(): { title: string; text: string } {
  return {
    title: "O host está no Discord",
    text: "Dentro do Discord o jogo não faz a conexão direta. O host precisa abrir o jogo no navegador (Abrir no navegador) e abrir a sala de lá.",
  };
}

/** What player 2 hears when the server's way stops. */
export function relayStuck(why: "closed" | "no-decoder" | "host-cant" | "restart"): { title: string; text: string } {
  switch (why) {
    case "restart":
      return { title: "O HypePlay está atualizando", text: "O servidor reinicia em instantes. Assim que ele voltar, esta página abre de novo sozinha." };
    case "closed":
      return { title: "A conexão com o servidor caiu", text: "O jogo do host parou de chegar. Tente de novo." };
    case "no-decoder":
      return { title: "Não deu para mostrar o jogo", text: "Este navegador não consegue mostrar o jogo pelo servidor. Use um Chrome ou Edge atualizado." };
    case "host-cant":
      return {
        title: "O host não consegue transmitir",
        text: "O navegador do host não consegue transmitir pelo servidor. Ele precisa de um Chrome ou Edge atualizado.",
      };
  }
}
