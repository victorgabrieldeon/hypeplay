import { expect, test } from "bun:test";
import { edgeDisc } from "./edgedisc";

const page = (content?: string) => ({ querySelector: () => (content === undefined ? null : { content }) }) as unknown as Pick<Document, "querySelector">;
const URL = "/p/edge/ps2/sles-50000/game/disc.iso?s=10&v=10:1&t=1.abc";

test("the edge's address only inside Discord, and only a path of the page's own origin", () => {
  expect(edgeDisc(page(URL), "123.discordsays.com")).toBe(URL);
  // (a tab of its own: that path is the app's server)
  expect(edgeDisc(page(URL), "hypeplay.example.com")).toBeNull();
  expect(edgeDisc(page(), "123.discordsays.com")).toBeNull();
  for (const other of ["https://elsewhere.example/disc.iso", "//elsewhere.example/disc.iso", "disc.iso", ""]) expect(edgeDisc(page(other), "123.discordsays.com")).toBeNull();
  expect(edgeDisc(page(URL), "discordsays.com.evil.example")).toBeNull();
});
