/** The daemon's own version, served by `/healthz`. Lives here so server.ts
 *  stays free of filesystem access. Resolves from both `src/` and `dist/`. */
import { readFileSync } from "node:fs";

let cached: string | undefined;

export function packageVersion(): string {
  if (cached === undefined) {
    try {
      const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
      cached = String((JSON.parse(raw) as { version?: unknown }).version ?? "0.0.0");
    } catch {
      cached = "0.0.0"; // a missing package.json must not take the daemon down
    }
  }
  return cached;
}
