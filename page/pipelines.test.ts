import { expect, test } from "bun:test";
import { CAPACITY, decodeList, encodeList, KEY_BYTES, mergeLists, type PipeList } from "./pipelines";

const key = (n: number) => new Uint8Array(KEY_BYTES).fill(n);
const list = (version: [number, number], ...ns: number[]): PipeList => {
  const keys = new Uint8Array(ns.length * KEY_BYTES);
  ns.forEach((n, i) => keys.set(key(n), i * KEY_BYTES));
  return { version, keys };
};
const ids = (l: PipeList | null) => (l ? Array.from({ length: l.keys.length / KEY_BYTES }, (_, i) => l.keys[i * KEY_BYTES]) : null);

test("a list goes to the server and back as it was", () => {
  const l = list([7, 0x80000001], 1, 2, 3);
  const back = decodeList(encodeList(l))!;
  expect(back.version).toEqual([7, 0x80000001]);
  expect(ids(back)).toEqual([1, 2, 3]);
});

test("what isn't a list is refused: too short, a broken key, too many keys", () => {
  expect(decodeList(new Uint8Array(4))).toBeNull();
  expect(decodeList(new Uint8Array(8 + KEY_BYTES - 1))).toBeNull();
  expect(decodeList(new Uint8Array(8 + (CAPACITY + 1) * KEY_BYTES))).toBeNull();
  expect(ids(decodeList(new Uint8Array(8)))).toEqual([]);
});

test("two lists of the same version: the first's keys, then the other's it hasn't got", () => {
  expect(ids(mergeLists(list([1, 0], 1, 2), list([1, 0], 2, 3, 4)))).toEqual([1, 2, 3, 4]);
});

test("lists of different versions don't mix: the first stands", () => {
  expect(ids(mergeLists(list([2, 0], 5), list([1, 0], 1, 2)))).toEqual([5]);
  expect(mergeLists(list([2, 0], 5), list([1, 0], 1))!.version).toEqual([2, 0]);
});

test("a missing list is no list", () => {
  expect(ids(mergeLists(null, list([1, 0], 1)))).toEqual([1]);
  expect(ids(mergeLists(list([1, 0], 1), null))).toEqual([1]);
  expect(mergeLists(null, null)).toBeNull();
});

test("a merged list stops at the emulator's capacity", () => {
  const a = list([1, 0], ...Array.from({ length: CAPACITY }, (_, i) => i & 255));
  // (keys made unique by their second byte)
  for (let i = 0; i < CAPACITY; i++) a.keys[i * KEY_BYTES + 1] = i >> 8;
  const merged = mergeLists(a, list([1, 0], 251))!;
  expect(merged.keys.length).toBe(CAPACITY * KEY_BYTES);
  expect(merged.keys[0]).toBe(0);
});
