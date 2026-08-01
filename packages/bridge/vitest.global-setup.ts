/**
 * `cli.test.ts` and `mcp.test.ts` both spawn the *built* `dist/cli.js`, so the
 * build runs once here rather than in each suite's `beforeAll` — two `tsc`
 * processes writing the same `dist/` in parallel can hand a spawned node a
 * half-written file. A failing build fails the whole run, which keeps the
 * "the bin is runnable" guarantee those suites carry.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = fileURLToPath(new URL(".", import.meta.url));

export async function setup(): Promise<void> {
  await execFileAsync(path.join(packageDir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: packageDir,
  });
}
