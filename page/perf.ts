// The PS2 games' parts of the game's panel (overlay.js), added by ps2play.ts to its Vídeo, CPU and Sistema tabs.
// TabStationToo's own settings, whose menus our design hides, as our buttons: pressing one presses the emulator's
// radio, so it applies and keeps the choice itself (the underclock per game, the picture's resolution at once, the
// renderer at the next opening), and its speed meter, read once a second. Whether the whole disc goes to the browser
// in the background (disccache.ts, in the disc worker: they talk over a BroadcastChannel), with how far it is. And
// "Ao abrir o jogo" in each tab: PCSX2's own settings, which the emulator takes only when it starts (ps2play.ts puts bootParams() in the
// page's address before it loads): kept in this browser, for every game.
import type { FillProgress } from "./disccache";
import type { Tab } from "./overlay";

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

const UNDERCLOCK: Group = {
  name: "ee-rate",
  title: "Underclock",
  hint: "Deixa as cenas pesadas mais leves. Alguns jogos ficam lentos ou com falhas. Fica guardado para este jogo.",
  choices: [
    { value: "0", label: "Desligado" },
    { value: "-1", label: "Leve" },
    { value: "-2", label: "Médio" },
    { value: "-3", label: "Forte" },
  ],
};
const GRAPHICS: Group[] = [
  {
    name: "gfx-scale",
    title: "Resolução",
    // (our core takes 1 to 4: pcsx2web_set_upscale drops anything else, and the GS caps it at the GPU's largest texture)
    hint: "Mais alta é mais nítida e pesa mais na placa de vídeo: 2× é perto de 720p, 3× de 1080p, 4× de 1440p. Se o jogo ficar lento, desça um nível.",
    choices: [
      { value: "1", label: "Nativa" },
      { value: "2", label: "2×" },
      { value: "3", label: "3×" },
      { value: "4", label: "4×" },
    ],
  },
  {
    name: "gfx-choice",
    title: "Quem desenha",
    hint: "Placa de vídeo é bem mais rápido. Processador só serve se a placa não funcionar. Vale quando o jogo abrir de novo.",
    choices: [
      { value: "auto", label: "Automático" },
      { value: "gpu", label: "Placa" },
      { value: "sw", label: "Processador" },
    ],
  },
];

/** A setting the emulator takes only when it starts: `def` is its own default, which needs nothing in the address. */
export interface BootOption {
  id: string;
  /** The panel's tab it shows in. */
  tab: Tab;
  title: string;
  hint: string;
  def: string;
  choices: Choice[];
  /** What goes in the page's address for a value other than `def`. */
  params: (value: string) => [string, string][];
}
/** PCSX2's `Section/Key` (as in its PCSX2.ini), through TabStationToo's ?set=. */
const ini = (path: string) => (value: string): [string, string][] => [["set", `${path}=${value}`]];
const OFF_ON = [
  { value: "false", label: "Desligado" },
  { value: "true", label: "Ligado" },
];

// To add one: its PCSX2.ini key (the emulator says "bad -set" in its log for a wrong one), or one of app.js' own
// ?switches (then its name in BOOT_PARAMS too). Never one the buttons above already own (EECycleRate, the renderer,
// the upscale): two places would fight over it.
export const BOOT: BootOption[] = [
  {
    id: "cycleskip",
    tab: "cpu",
    title: "Pular ciclos do processador",
    hint: "Outro jeito de aliviar o processador do PS2, mais forte que o underclock. Pode deixar o jogo instável.",
    def: "0",
    choices: [
      { value: "0", label: "Desligado" },
      { value: "1", label: "Leve" },
      { value: "2", label: "Médio" },
      { value: "3", label: "Forte" },
    ],
    params: ini("EmuCore/Speedhacks/EECycleSkip"),
  },
  {
    id: "fastcdvd",
    tab: "system",
    title: "Carregamento rápido",
    hint: "Lê o disco mais depressa: telas de carregamento mais curtas. Alguns jogos travam com ele.",
    def: "false",
    choices: OFF_ON,
    params: ini("EmuCore/Speedhacks/fastCDVD"),
  },
  {
    id: "blend",
    tab: "video",
    title: "Precisão das cores",
    hint: "Mais alta acerta brilhos, sombras e transparências, mas pesa na placa de vídeo. Só com a placa.",
    def: "1",
    // (no "0", Mínima: TabStationToo's WebGPU renderer samples an RGBA16Unorm texture as float there and every frame
    // is dropped, a black screen once a game draws its 3D; a saved "0" is left out by bootParams)
    choices: [
      { value: "1", label: "Básica" },
      { value: "2", label: "Média" },
      { value: "3", label: "Alta" },
    ],
    params: ini("EmuCore/GS/accurate_blending_unit"),
  },
  {
    id: "aniso",
    tab: "video",
    title: "Filtro anisotrópico",
    hint: "Texturas do chão mais nítidas de longe. Pesa pouco. Só com a placa.",
    def: "0",
    choices: [
      { value: "0", label: "Desligado" },
      { value: "4", label: "4×" },
      { value: "8", label: "8×" },
      { value: "16", label: "16×" },
    ],
    params: ini("EmuCore/GS/MaxAnisotropy"),
  },
  {
    id: "fxaa",
    tab: "video",
    title: "Suavizar serrilhado (FXAA)",
    hint: "Alisa as bordas em escada. Pesa pouco; pode borrar letras pequenas. Só com a placa.",
    def: "false",
    choices: OFF_ON,
    params: ini("EmuCore/GS/fxaa"),
  },
  {
    id: "deinterlace",
    tab: "video",
    title: "Desentrelaçamento",
    hint: "Tira o tremido das linhas em jogos entrelaçados. Automático acerta na maioria.",
    def: "0",
    // (no "1", Desligado: like Mínima above, TabStationToo's WebGPU renderer then samples an RGBA16Unorm texture as
    // float and drops every frame, a black screen in 3D; a saved "1" is left out by bootParams)
    choices: [
      { value: "0", label: "Automático" },
      { value: "6", label: "Mistura" },
      { value: "8", label: "Adaptativo" },
    ],
    params: ini("EmuCore/GS/deinterlace_mode"),
  },
  {
    id: "vu1jit",
    tab: "cpu",
    title: "Contas 3D (VU1)",
    hint: "Compatível é mais lento, mas corrige gráficos quebrados em alguns jogos.",
    def: "1",
    choices: [
      { value: "1", label: "Rápido" },
      { value: "0", label: "Compatível" },
    ],
    params: (v) => [["vu1jit", v]],
  },
  {
    id: "fastboot",
    tab: "system",
    title: "Abertura do PS2",
    hint: "Mostrar passa pela tela do PS2 antes do jogo, como no console. Alguns jogos só abrem assim.",
    def: "1",
    choices: [
      { value: "1", label: "Pular" },
      { value: "0", label: "Mostrar" },
    ],
    params: (v) => [["fastboot", v]],
  },
];
/** Every address parameter the options above write: ps2play.ts clears them first, so one turned off goes away. */
export const BOOT_PARAMS = ["set", "vu1jit", "fastboot"];

/** The address parameters for what's saved; anything unknown (an older option, a hand-edited value) is left out. */
export function bootParams(saved: Record<string, unknown>): [string, string][] {
  return BOOT.flatMap((o) => {
    const v = saved[o.id];
    return typeof v === "string" && v !== o.def && o.choices.some((c) => c.value === v) ? o.params(v) : [];
  });
}

const BOOT_PREF = "hypeplay.ps2.boot";
export function readBoot(): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(BOOT_PREF) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function writeBoot(saved: Record<string, unknown>) {
  try {
    localStorage.setItem(BOOT_PREF, JSON.stringify(saved));
  } catch {}
}

/** A titled row of buttons, one per choice (`mark` says what each one does), and its hint. */
function group(title: string, hint: string, choices: Choice[], mark: (b: HTMLButtonElement, c: Choice) => void): HTMLElement {
  const part = document.createElement("div");
  part.className = "cp-group";
  part.innerHTML = `<div class="cp-sub"></div><div class="cp-seg" role="group"></div><p class="cp-hint"></p>`;
  part.querySelector(".cp-sub")!.textContent = title;
  part.querySelector(".cp-seg")!.setAttribute("aria-label", title);
  part.querySelector(".cp-hint")!.textContent = hint;
  for (const c of choices) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.label;
    mark(b, c);
    part.querySelector(".cp-seg")!.append(b);
  }
  return part;
}
const radioGroup = (g: Group) => group(g.title, g.hint, g.choices, (b, c) => Object.assign(b.dataset, { radio: g.name, value: c.value }));

function section(title: string): HTMLElement {
  const s = document.createElement("section");
  s.className = "cp-sec";
  s.innerHTML = "<h3><span></span></h3>";
  s.querySelector("h3 span")!.textContent = title;
  return s;
}

/** The speed meter: the emulator's readout (its speed is "—" or hidden while no game runs); under 90% is slow. */
export function speedLine(speed: string | null, fps: string | null): { text: string; slow: boolean } {
  const s = speed?.trim() ?? "";
  if (!/^\d+%$/.test(s)) return { text: "", slow: false };
  return { text: `${s} · ${fps?.trim() || "0"} FPS`, slow: parseInt(s, 10) < 90 };
}

/** What to do about the speed, from how busy each of the PS2's threads is (EE, GS, VU; `null`: no reading). */
export function perfAdvice(speed: number | null, threads: number[] | null, upscaled: boolean): string {
  if (speed === null) return "";
  if (speed >= 90) return "Na velocidade normal: não precisa mexer. Se o FPS fica em 30, é o próprio jogo que roda assim.";
  const slow = "Abaixo da velocidade normal: ";
  const [ee = 0, gs = 0, vu = 0] = threads ?? [];
  if (Math.max(ee, gs, vu) < 1) return `${slow}tente a Resolução Nativa e o underclock Leve ou Médio.`;
  if (gs >= ee && gs >= vu)
    return upscaled ? `${slow}o que pesa é o desenho. Desça a Resolução (até a Nativa).` : `${slow}o que pesa é o desenho, e já está na Nativa: a placa de vídeo é o limite.`;
  if (ee >= vu) return `${slow}o que pesa é o processador do PS2. Tente o underclock Leve ou Médio.`;
  return `${slow}o que pesa são as contas 3D do PS2. O underclock ajuda pouco aqui; a Resolução Nativa pode aliviar.`;
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
  part.innerHTML = `<div class="cp-sub">Disco no navegador</div><div class="cp-seg" role="group" aria-label="Disco no navegador">
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

/** The picture's scaling: the emulator's Picture button (#btn-crisp), which cycles Smooth → Crisp → CRT. */
function pictureGroup(): HTMLElement {
  const part = document.createElement("div");
  part.className = "cp-group";
  part.innerHTML = `<div class="cp-sub">Nitidez</div><div class="cp-seg" role="group" aria-label="Nitidez">
    <button type="button" data-picture="Smooth">Suave</button><button type="button" data-picture="Crisp">Nítido</button></div>
    <p class="cp-hint">Nítido mostra os pixels como são; Suave alisa as bordas. Não pesa nada.</p>`;
  part.addEventListener("click", (e) => {
    const want = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-picture]")?.dataset.picture;
    // (at most a lap of the cycle: CRT is our own filter's job, overlay.ts)
    for (let i = 0; want && i < 3 && picture() !== want; i++) document.getElementById("btn-crisp")?.click();
  });
  return part;
}
const picture = () => document.getElementById("btn-crisp")?.getAttribute("aria-label")?.replace("Picture: ", "") ?? null;

const radio = (name: string, value: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);

/** The PS2 game's parts of the panel, each with its tab; `reopen` says a change waits for the game to open again. */
export function perfSections(reopen: () => void): [HTMLElement, Tab][] {
  const image = section("Imagem");
  image.append(...GRAPHICS.map(radioGroup), pictureGroup());

  const speed = section("Velocidade");
  speed.querySelector("h3")!.insertAdjacentHTML("beforeend", '<span class="cp-speed"></span>');
  speed.insertAdjacentHTML("beforeend", '<p class="cp-hint cp-advice" aria-live="polite"></p>');
  speed.append(radioGroup(UNDERCLOCK));

  const disc = section("Disco");
  disc.append(discGroup());

  /** A tab's "Ao abrir o jogo": its BOOT options, and the way back to their defaults. */
  const atBoot = (t: Tab) => {
    const opts = BOOT.filter((o) => o.tab === t);
    const s = section("Ao abrir o jogo");
    s.insertAdjacentHTML("beforeend", '<p class="cp-hint">Configurações do PCSX2 para todos os jogos neste navegador. Valem quando o jogo abrir de novo.</p>');
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "cp-quiet";
    reset.textContent = "Voltar ao padrão";
    reset.dataset.reset = opts.map((o) => o.id).join(" ");
    s.append(...opts.map((o) => group(o.title, o.hint, o.choices, (b, c) => Object.assign(b.dataset, { boot: o.id, value: c.value }))), reset);
    return s;
  };

  const parts: [HTMLElement, Tab][] = [
    [image, "video"],
    [atBoot("video"), "video"],
    [speed, "cpu"],
    [atBoot("cpu"), "cpu"],
    [disc, "system"],
    [atBoot("system"), "system"],
  ];
  const all = parts.map(([el]) => el);
  const within = (sel: string) => all.flatMap((el) => [...el.querySelectorAll<HTMLElement>(sel)]);
  const sync = () => {
    const saved = readBoot();
    for (const b of within("[data-boot]")) {
      const o = BOOT.find((x) => x.id === b.dataset.boot)!;
      const v = saved[o.id];
      const now = typeof v === "string" && o.choices.some((c) => c.value === v) ? v : o.def;
      b.setAttribute("aria-pressed", String(b.dataset.value === now));
    }
    for (const r of within("[data-reset]")) r.hidden = !bootParams(Object.fromEntries(r.dataset.reset!.split(" ").map((id) => [id, saved[id]]))).length;
    for (const b of within("[data-radio]") as HTMLButtonElement[]) {
      const r = radio(b.dataset.radio!, b.dataset.value!);
      b.setAttribute("aria-pressed", String(!!r?.checked));
      b.disabled = !r || r.disabled;
    }
    for (const b of within("[data-picture]") as HTMLButtonElement[]) {
      b.setAttribute("aria-pressed", String(b.dataset.picture === picture()));
      b.disabled = picture() === null;
    }
    const wrap = document.getElementById("r-speed-wrap");
    const line = speedLine(wrap && !wrap.hidden ? document.getElementById("r-speed")?.textContent ?? null : null, document.getElementById("r-fps")?.textContent ?? null);
    const meter = speed.querySelector<HTMLElement>(".cp-speed")!;
    meter.textContent = line.text;
    meter.classList.toggle("slow", line.slow);
    const M = (window as unknown as { Module?: { _pcsx2web_thread_usage?: (i: number) => number } }).Module;
    const threads = M?._pcsx2web_thread_usage ? [0, 1, 2].map((i) => M._pcsx2web_thread_usage!(i)) : null;
    const advice = speed.querySelector<HTMLElement>(".cp-advice")!;
    advice.textContent = perfAdvice(line.text ? parseInt(line.text, 10) : null, threads, Number(document.querySelector<HTMLInputElement>('input[name="gfx-scale"]:checked')?.value ?? 1) > 1);
    advice.hidden = !advice.textContent;
    advice.classList.toggle("cp-slow", line.slow);
  };
  for (const s of all)
    s.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-picture]")) queueMicrotask(sync);
      const boot = t.closest<HTMLButtonElement>("[data-boot]");
      const reset = t.closest<HTMLElement>("[data-reset]");
      if (boot || reset) {
        const saved = readBoot();
        if (boot) saved[boot.dataset.boot!] = boot.dataset.value!;
        else for (const id of reset!.dataset.reset!.split(" ")) delete saved[id];
        writeBoot(saved);
        reopen();
        return sync();
      }
      const b = t.closest<HTMLButtonElement>("[data-radio]");
      const r = b && radio(b.dataset.radio!, b.dataset.value!);
      if (!b || !r || r.disabled || r.checked) return;
      r.checked = true;
      r.dispatchEvent(new Event("change", { bubbles: true }));
      if (b.dataset.radio === "gfx-choice") reopen();
      sync();
    });
  // (only while the panel shows it: nothing to read every second otherwise)
  setInterval(() => {
    if (all.some((el) => el.offsetParent)) sync();
  }, 1000);
  sync();
  return parts;
}
