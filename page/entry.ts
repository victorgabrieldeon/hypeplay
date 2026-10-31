// The entry page's script (page/entry.html), bundled with the Discord SDK at startup (server/index.ts), which also
// fills in DISCORD_CLIENT_ID and PUBLIC_URL.
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { openRequest } from "./open";

const msg = document.getElementById("msg")!;
const game = document.getElementById("game") as HTMLIFrameElement;

/** Outside Discord (a browser): sign in on Discord's own page (the server's /login), when the server has PUBLIC_URL. */
function inBrowser() {
  msg.textContent = "No navegador: entre com a sua conta do Discord.";
  document.querySelector(".splash")!.classList.add("browser");
  document.getElementById("login")!.hidden = false;
}

async function start() {
  let sdk: DiscordSDK;
  try {
    sdk = new DiscordSDK(process.env.DISCORD_CLIENT_ID!);
  } catch {
    if (process.env.PUBLIC_URL) return inBrowser();
    throw new Error("Abra o HypePlay pelo 🚀 de um canal de voz do Discord.");
  }
  await sdk.ready();
  // What "Abrir no navegador" opens: PUBLIC_URL, or the address the server says it was asked by (with the pass, below)
  let base = process.env.PUBLIC_URL ?? "";
  // "Abrir no navegador" from a page Discord holds back (a PS2 game's isolation, player 2's WebRTC, the controller).
  // The page gets the link at once ("opening": to click or copy should Discord not open it, which some Discord apps
  // leave unanswered), then why, when Discord refused or said nothing for a while (no PUBLIC_URL: no link at all).
  window.addEventListener("message", (e) => {
    if (e.source !== game.contentWindow || (e.data as { t?: unknown } | null)?.t !== "cordplay:open") return;
    const say = (msg: object) => game.contentWindow?.postMessage(msg, "*");
    const tell = (why: string, url?: string) => say({ t: "cordplay:cant-open", why, url });
    const url = openRequest(e.data, base);
    if (!url) return tell(base ? "Essa página não abre fora do Discord." : "Este servidor não tem o PUBLIC_URL configurado.");
    say({ t: "cordplay:opening", url });
    const quiet = new Promise<"quiet">((ok) => setTimeout(() => ok("quiet"), 5000));
    Promise.race([sdk.commands.openExternalLink({ url }), quiet])
      .then((r) => {
        if (r === "quiet") tell("O Discord não respondeu ao pedido de abrir o link.", url);
        else if (r?.opened === false) tell("O Discord não abriu o link.", url);
      })
      .catch((err: unknown) => tell(`O Discord recusou abrir o link (${err instanceof Error ? err.message : JSON.stringify(err)}).`, url));
  });
  // Asks for consent the first time only; after that it's silent.
  const { code } = await sdk.commands.authorize({
    client_id: sdk.clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });
  const res = await fetch("token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const body = (await res.json().catch(() => ({}))) as { pass?: string; error?: string; access_token?: string; public_url?: string };
  if (!res.ok || !body.pass) throw new Error(body.error ?? `Erro ${res.status}`);
  if (!base && /^https?:\/\//.test(body.public_url ?? "")) base = body.public_url!;
  // (the SDK's own sign-in: some commands, opening a link outside Discord among them, want it; the games don't)
  if (body.access_token) await sdk.commands.authenticate({ access_token: body.access_token }).catch((err) => console.warn("HypePlay: authenticate", err));
  game.src = `p/${body.pass}/`;
  game.hidden = false;
  msg.hidden = true;
}

start().catch((err: unknown) => {
  msg.className = "error";
  msg.textContent = err instanceof Error ? err.message : "Não deu para entrar pelo Discord.";
});
