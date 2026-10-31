// The PS2 games' "Desempenho" in the game's panel (overlay.js), added by ps2play.ts: TabStationToo's own settings,
// whose menus our design hides, as our buttons. Pressing one presses the emulator's radio, so it applies and keeps the
// choice itself (the underclock per game, the picture's resolution at once, the renderer at the next opening), and its
// speed meter, read once a second.

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
