/**
 * Downloads EmulatorJS and the cores the homebrew catalog uses (server/homebrew.ts) into emulator/data/, which the
 * server serves at /p/<pass>/emulator/. From npm's tarballs, pinned and checked, not as dependencies: the package
 * pulls in its build tools and, optionally, every core (300 MB). Run by the Dockerfile; once by hand for dev.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const VERSION = "4.2.3";
// npm's dist.integrity for each tarball at VERSION.
const PACKAGES: Record<string, string> = {
  emulatorjs: "sha512-7z3qaA4LwyurhuGvdMUDF9xJpEbxC3SNy9+E9tSaOsRo8FCS2QXam/0k/lc9kqHWRFIlLKWahNjPAStyL0rFnw==",
  "core-gambatte": "sha512-Oq3AJL9SKnMsNAmtAP2eN934TQts3NHeaAe0z1BO9Lx/L3xDZKLpxL+XwgcSXIrl4Sx1oXxYEUwD7JjPEQ0DGg==",
  "core-mgba": "sha512-daiHzZQKEr+P9fra7j5YoEAXiyYUEtBhFQ8EAV/SeCtrkvqtayU7GQ9LYgoSgzkKSwsbNSskApqGuA9EGARYPA==",
  "core-fceumm": "sha512-XX9Vv2N/hzp0TstNMCTSppEs+sg+1lpJpPdSDuRqIO/cwdt7dUcF+WjNX1yQJLRbP5+XwcNHZ6K4BKy8CJpndQ==",
};

const data = join(import.meta.dir, "data");
await rm(data, { recursive: true, force: true });
await mkdir(join(data, "cores"), { recursive: true });

for (const [name, integrity] of Object.entries(PACKAGES)) {
  const res = await fetch(`https://registry.npmjs.org/@emulatorjs/${name}/-/${name}-${VERSION}.tgz`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const got = "sha512-" + new Bun.CryptoHasher("sha512").update(tgz).digest("base64");
  if (got !== integrity) throw new Error(`${name}: integrity mismatch`);
  // The player (package/data/) into data/; a core's files (package/*.data, package/reports/) into data/cores/.
  const args = name === "emulatorjs" ? ["-C", data, "--strip-components=2", "package/data"] : ["-C", join(data, "cores"), "--strip-components=1", "--wildcards", "package/*.data", "package/reports/*"];
  const tar = Bun.spawn(["tar", "xz", ...args], { stdin: tgz, stderr: "inherit" });
  if ((await tar.exited) !== 0) throw new Error(`${name}: tar failed`);
  console.log(`${name} ${VERSION}`);
}
