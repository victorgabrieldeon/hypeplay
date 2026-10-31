// The PS2 games' "Desempenho" in the game's panel (overlay.js), added by ps2play.ts: TabStationToo's own settings,
// whose menus our design hides, as our buttons. Pressing one presses the emulator's radio, so it applies and keeps the
// choice itself (the underclock per game, the picture's resolution at once, the renderer at the next opening), and its
// speed meter, read once a second. And whether the whole disc goes to the browser in the background (disccache.ts,
// in the disc worker: they talk over a BroadcastChannel), with how far it is.
import type { FillProgress } from "./disccache";

interface Choice {
  value: string;
  label: string;
}
interface Group {
  /** The emulator's radios' name. */
  name: string;
  title: string;
  hint: string;
  choices: Choice[];
}

const GROUPS: Group[] = [
  {
    name: "ee-rate",
    title: "Underclock",
    hint: "Deixa as cenas pesadas mais leves. Alguns jogos ficam lentos ou com falhas. Fica guardado para este jogo.",
    choices: [
      { value: "0", label: "Desligado" },
      { value: "-1", label: "Leve" },
      { value: "-2", label: "Médio" },
      { value: "-3", label: "Forte" },
    ],
  },
  {
    name: "gfx-scale",
    title: "Resolução",
    hint: "2× fica mais nítido e pesa mais na placa de vídeo.",
    choices: [
      { value: "1", label: "Nativa" },
      { value: "2", label: "2×" },
    ],
  },
  {
    name: "gfx-choice",
    title: "Quem desenha",
    hint: "Placa de vídeo é bem mais rápido. Processador só serve se a placa não funcionar.",
    choices: [
      { value: "auto", label: "Automático" },
      { value: "gpu", label: "Placa" },
      { value: "sw", label: "Processador" },
    ],
  },
];

/** The speed meter: the emulator's readout (its speed is "—" or hidden while no game runs); under 90% is slow. */
export function speedLine(speed: string | null, fps: string | null): { text: string; slow: boolean } {
  const s = speed?.trim() ?? "";
  if (!/^\d+%$/.test(s)) return { text: "", slow: false };
  return { text: `${s} · ${fps?.trim() || "0"} FPS`, slow: parseInt(s, 10) < 90 };
}

const gb = (blocks: number) => (blocks / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 });

/** The whole disc in the browser: how far (`null`: the disc isn't open yet). */
export function fillLine(p: FillProgress | null): string {
  if (!p) return "O disco abre quando o jogo começar.";
  const pct = p.total ? Math.floor((p.have / p.total) * 100) : 0;
  switch (p.state) {
    case "checking":
      return "Vendo o que já está no navegador…";
    case "filling":
      return `Baixando o disco: ${pct}% (${gb(p.have)} de ${gb(p.total)} GB). Quando acabar, o jogo não depende mais da internet.`;
    case "done":
      return "O disco inteiro está no navegador: o jogo não depende mais da internet.";
    case "full":
      return "Acabou o espaço do navegador: só o que o jogo lê fica guardado.";
    default:
      return `Só o que o jogo lê fica no navegador (${pct}%); o resto vem da internet na hora.`;
  }
}

const FILL_PREF = "hypeplay.discFill";
const fillWanted = () => {
  try {
    return localStorage.getItem(FILL_PREF) !== "0";
  } catch {
    return true;
  }
};

/** The disc group: Baixar tudo / Só o que o jogo lê, and how far it is. */
function discGroup(): HTMLElement {
  // (this page's disc, as the worker names it: without the pass)
  const disc = `${location.pathname.replace(/^\/p\/[^/]+\//, "/")}disc.iso`;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hypeplay-disc") : null;
  const part = document.createElement("div");
  part.className = "cp-group";
  part.innerHTML = `<div class="cp-sub">Disco no navegador</div><div class="cp-seg" style="grid-template-columns: repeat(2, 1fr)" role="group" aria-label="Disco no navegador">
    <button type="button" data-fill="1">Baixar tudo</button><button type="button" data-fill="0">Só o que o jogo lê</button></div><p class="cp-hint" aria-live="polite"></p>`;
  const hint = part.querySelector<HTMLElement>(".cp-hint")!;
  let last: FillProgress | null = null;
  const show = () => {
    const on = fillWanted();
    for (const b of part.querySelectorAll<HTMLButtonElement>("[data-fill]")) b.setAttribute("aria-pressed", String((b.dataset.fill === "1") === on));
    hint.textContent = fillLine(last);
  };
  const tell = () => {
    const on = fillWanted();
    // (a disc this big is worth keeping: the browser shouldn't drop it to make room)
    if (on) void navigator.storage?.persist?.().catch(() => {});
    channel?.postMessage({ t: "fill", disc, on });
  };
  channel?.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as ({ t?: string; disc?: string } & Partial<FillProgress>) | null;
    if (m?.disc !== disc) return;
    if (m.t === "hello") tell();
    if (m.t === "progress" && typeof m.have === "number" && typeof m.total === "number" && m.state) {
      last = { have: m.have, total: m.total, state: m.state };
      show();
    }
  });
  part.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-fill]");
    if (!b) return;
    try {
      localStorage.setItem(FILL_PREF, b.dataset.fill!);
    } catch {}
    tell();
    show();
  });
  tell();
  show();
  return part;
}

const radio = (name: string, value: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);

export function perfSection(): HTMLElement {
  const box = document.createElement("div");
  box.className = "cp-perf";
  box.innerHTML = `<div class="cp-label"><span>Desempenho</span><span class="cp-speed"></span></div><p class="cp-hint cp-slow" hidden>O jogo está abaixo da velocidade normal: tente o underclock Leve ou Médio.</p>`;
  for (const g of GROUPS) {
    const part = document.createElement("div");
    part.className = "cp-group";
    part.innerHTML = `<div class="cp-sub"></div><div class="cp-seg" style="grid-template-columns: repeat(${g.choices.length}, 1fr)" role="group"></div><p class="cp-hint"></p>`;
    part.querySelector(".cp-sub")!.textContent = g.title;
    part.querySelector(".cp-seg")!.setAttribute("aria-label", g.title);
    part.querySelector(".cp-hint")!.textContent = g.hint;
    for (const c of g.choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c.label;
      b.dataset.radio = g.name;
      b.dataset.value = c.value;
      part.querySelector(".cp-seg")!.append(b);
    }
    box.append(part);
  }
  box.append(discGroup());
  const reopen = document.createElement("p");
  reopen.className = "cp-hint cp-reopen";
  reopen.hidden = true;
  reopen.innerHTML = 'Vale quando o jogo abrir de novo (o que não foi salvo se perde). <button type="button">Reabrir agora</button>';
  reopen.querySelector("button")!.addEventListener("click", () => location.reload());
  box.append(reopen);

  const sync = () => {
    for (const b of box.querySelectorAll<HTMLButtonElement>("[data-radio]")) {
      const r = radio(b.dataset.radio!, b.dataset.value!);
      b.setAttribute("aria-pressed", String(!!r?.checked));
      b.disabled = !r || r.disabled;
    }
    const wrap = document.getElementById("r-speed-wrap");
    const line = speedLine(wrap && !wrap.hidden ? document.getElementById("r-speed")?.textContent ?? null : null, document.getElementById("r-fps")?.textContent ?? null);
    const speed = box.querySelector<HTMLElement>(".cp-speed")!;
    speed.textContent = line.text;
    speed.classList.toggle("slow", line.slow);
    box.querySelector<HTMLElement>(".cp-slow")!.hidden = !line.slow;
  };
  box.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-radio]");
    const r = b && radio(b.dataset.radio!, b.dataset.value!);
    if (!b || !r || r.disabled || r.checked) return;
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
    if (b.dataset.radio === "gfx-choice") reopen.hidden = false;
    sync();
  });
  // (only while the panel shows it: nothing to read every second otherwise)
  setInterval(() => {
    if (box.offsetParent) sync();
  }, 1000);
  sync();
  return box;
}
