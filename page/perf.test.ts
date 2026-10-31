import { expect, test } from "bun:test";
import { speedLine } from "./perf";

test("the speed meter: the emulator's speed and frames, or that no game runs yet", () => {
  expect(speedLine("100%", "60")).toEqual({ text: "100% · 60 FPS", slow: false });
  expect(speedLine("87%", "52")).toEqual({ text: "87% · 52 FPS", slow: true });
  expect(speedLine(" 99% ", null)).toEqual({ text: "99% · 0 FPS", slow: false });
  expect(speedLine(null, "0")).toEqual({ text: "", slow: false });
  expect(speedLine("—", "0")).toEqual({ text: "", slow: false });
});
