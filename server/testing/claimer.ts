/**
 * One worker for queue.test.ts' concurrent claims: claims from the queue at argv[2] until it's empty, holding each job a
 * moment, and prints the keys it got (one per line). Run as its own process, so the claims really race.
 */
import { createQueue } from "../queue";

const [path, worker] = process.argv.slice(2) as [string, string];
const queue = createQueue(path);
const got: string[] = [];
// (all of them start together: each waits for the go file)
while (!(await Bun.file(`${path}.go`).exists())) await Bun.sleep(2);
for (;;) {
  const c = queue.claim(worker, { kinds: ["ps2"] });
  if (!c) break;
  got.push(c.key);
  await Bun.sleep(1);
  if (!queue.done(c.key, c.token)) throw new Error(`${worker} lost ${c.key}`);
}
queue.close();
console.log(got.join("\n"));
