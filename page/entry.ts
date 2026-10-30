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
  // "Abrir no navegador" from a page Discord holds back (a PS2 game's isolation, player 2's WebRTC, the controller);
  // without PUBLIC_URL there's nowhere to send it, and the page is told so.
  window.addEventListener("message", (e) => {
    if (e.source !== game.contentWindow) return;
    const url = openRequest(e.data, process.env.PUBLIC_URL ?? "");
    if (url) sdk.commands.openExternalLink({ url }).catch(() => {});
    else if ((e.data as { t?: unknown } | null)?.t === "cordplay:open") game.contentWindow?.postMessage({ t: "cordplay:cant-open" }, "*");
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
  const body = (await res.json().catch(() => ({}))) as { pass?: string; error?: string };
  if (!res.ok || !body.pass) throw new Error(body.error ?? `Erro ${res.status}`);
  game.src = `p/${body.pass}/`;
  game.hidden = false;
  msg.hidden = true;
}

start().catch((err: unknown) => {
  msg.className = "error";
  msg.textContent = err instanceof Error ? err.message : "Não deu para entrar pelo Discord.";
});
