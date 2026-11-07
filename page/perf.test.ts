import { expect, test } from "bun:test";
import { fillLine, perfAdvice, speedLine } from "./perf";

test("the speed meter: the emulator's speed and frames, or that no game runs yet", () => {
  expect(speedLine("100%", "60")).toEqual({ text: "100% · 60 FPS", slow: false });
  expect(speedLine("87%", "52")).toEqual({ text: "87% · 52 FPS", slow: true });
  expect(speedLine(" 99% ", null)).toEqual({ text: "99% · 0 FPS", slow: false });
  expect(speedLine(null, "0")).toEqual({ text: "", slow: false });
  expect(speedLine("—", "0")).toEqual({ text: "", slow: false });
});

test("the whole disc in the browser: how far, in the person's words", () => {
  expect(fillLine({ have: 1331, total: 3072, state: "filling" })).toBe("Baixando o disco: 43% (1,3 de 3 GB). Quando acabar, o jogo não depende mais da internet.");
  expect(fillLine({ have: 3072, total: 3072, state: "done" })).toBe("O disco inteiro está no navegador: o jogo não depende mais da internet.");
  expect(fillLine({ have: 10, total: 3072, state: "full" })).toBe("Acabou o espaço do navegador: só o que o jogo lê fica guardado.");
  expect(fillLine({ have: 0, total: 3072, state: "checking" })).toBe("Vendo o que já está no navegador…");
  expect(fillLine({ have: 512, total: 3072, state: "off" })).toBe("Só o que o jogo lê fica no navegador (16%); o resto vem da internet na hora.");
  expect(fillLine(null)).toBe("O disco abre quando o jogo começar.");
});

test("the speed advice: what weighs, from the PS2's threads (EE, GS, VU)", () => {
  expect(perfAdvice(null, null, false)).toBe("");
  expect(perfAdvice(100, [40, 30, 20], true)).toContain("não precisa mexer");
  expect(perfAdvice(70, [60, 99, 40], true)).toContain("Volte a Resolução para Nativa");
  expect(perfAdvice(70, [60, 99, 40], false)).toContain("a placa de vídeo é o limite");
  expect(perfAdvice(70, [99, 50, 40], false)).toContain("underclock Leve ou Médio");
  expect(perfAdvice(70, [50, 40, 99], false)).toContain("contas 3D");
  expect(perfAdvice(70, [0, 0, 0], false)).toContain("Resolução Nativa e o underclock");
  expect(perfAdvice(70, null, false)).toContain("Resolução Nativa e o underclock");
});
