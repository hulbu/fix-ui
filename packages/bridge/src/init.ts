/**
 * `fixui init` — the whole install, run once inside a project.
 *
 * Seven effects, one rule: **every write is additive, and nothing this command
 * did not create is ever clobbered.** Running it twice must leave the project
 * byte-for-byte as the first run left it, because the realistic invocation is a
 * developer (or an agent) running it again to check, not to change anything.
 *
 * The two source edits — wrapping the `dev` script so the bridge's lifetime is
 * the dev server's, and inserting the shipped adapter — are done with careful
 * string work and no AST library. That trade is deliberate: an edit this small
 * does not justify a parser dependency, and the cost of the trade is paid by
 * **skipping loudly**. Every shape this file does not recognise leaves the file
 * untouched and tells the caller the one line to add by hand. A skipped edit is
 * a minute of someone's time; a mangled root layout is an afternoon.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Stack = "next-app" | "next-pages" | "vite" | "unknown";
export type PackageManager = "pnpm" | "yarn" | "npm";

/** The embed (adapters) and the bridge (the `fixui` bin the dev script calls). */
const EMBED = "@hulbu/fixui";
const BRIDGE = "fixui-bridge";

/** Next must transpile the embed: it ships raw TypeScript, and without this the
 *  integration fails silently rather than loudly. */
const TRANSPILE = [EMBED, "@hulbu/fixui-core"];

const IGNORES = [".fix-ui.json", ".fix-ui.jsonl", ".fix-ui.reviews.jsonl"];

/** A JS array literal, spaced the way the file it is going into is written. */
function literal(names: string[]): string {
  return `[${names.map((name) => JSON.stringify(name)).join(", ")}]`;
}

/** The one line a consuming project's CLAUDE.md needs (docs/agent-integration.md). */
const CLAUDE_LINE =
  '"fix ui" → read `.fix-ui.jsonl` (or the fixui MCP tools) and fix the entries;' +
  " after UI work, call `request_review` before claiming done.";

/** What tells us the line is already there, however the developer reworded it. */
const CLAUDE_MARKER = ".fix-ui.jsonl";

export interface InstallPlan {
  manager: PackageManager;
  /** Exactly what a human would type — printed verbatim when the install fails. */
  command: string[];
  /** name → specifier, so a caller can see what is being asked for. */
  packages: Record<string, string>;
  cwd: string;
}

export type Installer = (plan: InstallPlan) => Promise<boolean>;

export interface InitOptions {
  /** The project to set up. */
  project: string;
  /** Absolute path to a fix-ui checkout: local mode, for while it is unpublished. */
  local?: string;
  /** Where the shipped skill is copied from. Defaults to the one beside this package. */
  skillSource?: string;
  /** Runs the package manager. Injected by tests; the real one shells out. */
  install?: Installer;
  log(message: string): void;
}

export interface InitResult {
  stack: Stack;
  manager: PackageManager;
  /** One line per thing actually changed. Empty on a second run — that is the
   *  machine-checkable form of "idempotent". */
  changed: string[];
  /** One line per thing deliberately not done, each naming the manual fix. */
  skipped: string[];
  /** The single thing to do next. */
  nextStep: string;
}

// ── filesystem helpers ──────────────────────────────────────────────────────

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(file: string): Promise<boolean> {
  return (await readText(file)) !== undefined;
}

/** Writes only when the bytes would differ, so a rerun touches nothing. */
async function writeIfDifferent(file: string, content: Buffer): Promise<boolean> {
  const existing = await readFile(file).catch(() => undefined);
  if (existing !== undefined && existing.equals(content)) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return true;
}

/** A JSON file re-read from disk, or `undefined` if it went missing or unparseable. */
async function reparse(file: string): Promise<Manifest | undefined> {
  const raw = await readText(file);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as Manifest;
  } catch {
    return undefined;
  }
}

/** The indent a JSON file already uses, so rewriting it is not a reformat. */
function detectIndent(source: string): string {
  return /^[ \t]+(?=["\w])/m.exec(source)?.[0] ?? "  ";
}

// ── the skill ───────────────────────────────────────────────────────────────

/**
 * The shipped `skills/fix-ui/` directory: beside the package when installed,
 * at the repo root when running from a checkout. `undefined` means we have no
 * skill to copy, which is reported rather than papered over.
 */
export async function resolveSkillSource(local?: string): Promise<string | undefined> {
  const here = fileURLToPath(new URL(".", import.meta.url)); // src/ or dist/
  const candidates = [
    ...(local === undefined ? [] : [path.join(local, "skills", "fix-ui")]),
    path.join(here, "..", "skills", "fix-ui"), // published layout
    path.join(here, "..", "..", "..", "skills", "fix-ui"), // this repo
  ];
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "SKILL.md"))) return candidate;
  }
  return undefined;
}

/** Recursive, file by file, so an unchanged skill is not rewritten. */
async function copyTree(from: string, to: string): Promise<string[]> {
  const written: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) written.push(...(await copyTree(source, target)));
    else if (await writeIfDifferent(target, await readFile(source))) written.push(target);
  }
  return written;
}

// ── the package manager ─────────────────────────────────────────────────────

async function detectManager(project: string): Promise<PackageManager> {
  if (await fileExists(path.join(project, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(project, "yarn.lock"))) return "yarn";
  return "npm"; // package-lock.json, and the default for a project with no lockfile
}

function installArgv(manager: PackageManager, specs: string[]): string[] {
  if (manager === "pnpm") return ["pnpm", "add", "-D", ...specs];
  if (manager === "yarn") return ["yarn", "add", "--dev", ...specs];
  return ["npm", "install", "--save-dev", ...specs];
}

/**
 * A local checkout is referenced, never copied: `link:` for pnpm (which
 * symlinks, so the checkout's own `workspace:` dependencies still resolve) and
 * `file:` for npm and yarn.
 */
function localSpec(manager: PackageManager, dir: string): string {
  return `${manager === "pnpm" ? "link" : "file"}:${dir}`;
}

/** The real installer: the package manager, wearing our stdio. */
const shellInstall: Installer = async (plan) =>
  new Promise<boolean>((resolve) => {
    const [file, ...args] = plan.command as [string, ...string[]];
    const child = spawn(file, args, {
      cwd: plan.cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });

// ── source edits: shared string surgery ─────────────────────────────────────

/**
 * The first line an import can go on: past the file's docblock, its leading
 * comments and any `"use client"`-style directive. Deliberately *before* the
 * existing imports rather than after them — always syntactically valid, and it
 * cannot land in the middle of a multi-line import.
 */
function importLine(lines: string[]): number {
  let index = 0;
  let inBlock = false;
  for (; index < lines.length; index += 1) {
    const text = lines[index]!.trim();
    if (inBlock) {
      if (text.includes("*/")) inBlock = false;
      continue;
    }
    if (text === "" || text.startsWith("//")) continue;
    if (text.startsWith("/*")) {
      if (!text.includes("*/")) inBlock = true;
      continue;
    }
    if (/^["'][^"']*["'];?$/.test(text)) continue; // "use client" and friends
    break;
  }
  return index;
}

function withImport(source: string, statement: string): string {
  const lines = source.split("\n");
  const at = importLine(lines);
  // A blank line after, unless it would separate us from the file's own
  // imports: an import glued to `export const metadata` reads like a mistake.
  const spacer = (lines[at] ?? "").trim().startsWith("import ") ? [] : [""];
  lines.splice(at, 0, statement, ...spacer);
  return lines.join("\n");
}

/** The indentation of the line `at` falls on. */
function indentOf(source: string, at: number): string {
  const start = source.lastIndexOf("\n", at) + 1;
  return /^[ \t]*/.exec(source.slice(start))![0];
}

// ── source edits: Next ──────────────────────────────────────────────────────

const NEXT_IMPORT = 'import { FixUiScript } from "@hulbu/fixui/next";';

/**
 * `<FixUiScript />` as the last thing in `<body>`. Exactly one `</body>` is the
 * only shape we act on: none means this is not the root layout we think it is,
 * and two means we would be guessing which one.
 */
function withFixUiScript(source: string): string | undefined {
  const close = source.indexOf("</body>");
  if (close === -1 || source.indexOf("</body>", close + 1) !== -1) return undefined;

  const lineStart = source.lastIndexOf("\n", close) + 1;
  const before = source.slice(lineStart, close);
  const inserted =
    before.trim() === ""
      ? `${source.slice(0, lineStart)}${before}  <FixUiScript />\n${source.slice(lineStart)}`
      : `${source.slice(0, close)}<FixUiScript />${source.slice(close)}`;
  return withImport(inserted, NEXT_IMPORT);
}

const NEXT_CONFIGS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "next.config.mts",
];

const NEW_NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  // @hulbu/fixui ships raw TypeScript, so Next has to transpile it.
  transpilePackages: ${literal(TRANSPILE)},
};

export default nextConfig;
`;

/** The object literal a Next config is: the three ways one is written. */
const CONFIG_OBJECT = [
  /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=;{]+)?=\s*\{/,
  /module\.exports\s*=\s*\{/,
  /export\s+default\s*\{/,
];

function withTranspilePackages(source: string): string | undefined {
  const existing = /transpilePackages\s*:\s*\[([^[\]]*)\]/.exec(source);
  if (existing !== null) {
    const listed = [...existing[1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
    const missing = TRANSPILE.filter((name) => !listed.includes(name));
    if (missing.length === 0) return source;
    const merged = `transpilePackages: ${literal([...listed, ...missing])}`;
    return (
      source.slice(0, existing.index) + merged + source.slice(existing.index + existing[0].length)
    );
  }
  // Named but in a shape we cannot read (a variable, a spread): do not guess.
  if (source.includes("transpilePackages")) return undefined;

  let at = -1;
  for (const pattern of CONFIG_OBJECT) {
    const match = pattern.exec(source);
    if (match === null) continue;
    const end = match.index + match[0].length;
    if (at === -1 || end < at) at = end;
  }
  if (at === -1) return undefined;

  const tail = source[at] === "\n" ? "" : "\n";
  return `${source.slice(0, at)}\n  transpilePackages: ${literal(TRANSPILE)},${tail}${source.slice(at)}`;
}

// ── source edits: Vite ──────────────────────────────────────────────────────

const VITE_IMPORT = 'import { fixui } from "@hulbu/fixui/vite";';

const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
  "vite.config.cts",
];

/**
 * `fixui()` first in the plugins array — first because it only needs to be *in*
 * it, and the head of the array is the one position findable without a parser.
 *
 * Exactly one `plugins:` in the file, for the same reason as `</body>`: a
 * config with a nested one (`css.postcss.plugins`) would have us guessing which
 * array Vite's own belongs to, and guessing wrong there is a broken build.
 */
function withVitePlugin(source: string): string | undefined {
  const all = [...source.matchAll(/plugins\s*:\s*\[/g)];
  if (all.length !== 1) return undefined;
  const match = all[0]!;

  const at = match.index + match[0].length;
  const indent = indentOf(source, match.index);
  const next = source[at];
  const insertion =
    next === "\n" ? `\n${indent}  fixui(),` : next === "]" ? "fixui()" : "fixui(), ";
  return withImport(`${source.slice(0, at)}${insertion}${source.slice(at)}`, VITE_IMPORT);
}

// ── the adapter table, for the cases we will not edit ───────────────────────

const ADAPTER_TABLE = [
  "  Next (app router)   import { FixUiScript } from \"@hulbu/fixui/next\"",
  "                      → render <FixUiScript /> last inside <body> in app/layout.tsx",
  "  Next (pages router) the same component",
  "                      → render <FixUiScript /> in pages/_app.tsx",
  "  Vite                import { fixui } from \"@hulbu/fixui/vite\"",
  "                      → add fixui() to plugins in vite.config.*",
  "  plain HTML          <script src=\"…/@hulbu/fixui/dist/fixui.global.js\" data-port … data-token …>",
  "  anything else       call initFixUi() from \"@hulbu/fixui\" in a dev-only entry point",
].join("\n");

// ── the command ─────────────────────────────────────────────────────────────

interface Manifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

async function detectStack(project: string, manifest: Manifest | undefined): Promise<Stack> {
  if (manifest === undefined) return "unknown";
  if (manifest.dependencies?.next !== undefined || manifest.devDependencies?.next !== undefined) {
    for (const dir of ["app", "src/app"]) {
      for (const extension of ["tsx", "jsx", "ts", "js"]) {
        if (await fileExists(path.join(project, dir, `layout.${extension}`))) return "next-app";
      }
    }
    return "next-pages";
  }
  if (manifest.devDependencies?.vite !== undefined || manifest.dependencies?.vite !== undefined) {
    return "vite";
  }
  return "unknown";
}

/** The first of `names` that is in the project, if any. */
async function findConfig(project: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await fileExists(path.join(project, name))) return name;
  }
  return undefined;
}

async function findLayout(project: string): Promise<string | undefined> {
  for (const dir of ["app", "src/app"]) {
    for (const extension of ["tsx", "jsx", "ts", "js"]) {
      const relative = path.join(dir, `layout.${extension}`);
      if (await fileExists(path.join(project, relative))) return relative;
    }
  }
  return undefined;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const { project, local, log } = options;
  const install = options.install ?? shellInstall;
  const changed: string[] = [];
  const skipped: string[] = [];

  const manifestFile = path.join(project, "package.json");
  const manifestRaw = await readText(manifestFile);
  let manifest: Manifest | undefined;
  if (manifestRaw === undefined) {
    skipped.push("no package.json here — the dependency and the dev script are yours to add");
  } else {
    try {
      manifest = JSON.parse(manifestRaw) as Manifest;
    } catch {
      skipped.push(
        "package.json is not valid JSON — left untouched;" +
          ` install ${EMBED} and wrap the dev script as \`fixui dev -- <your dev command>\` yourself`,
      );
    }
  }

  const manager = await detectManager(project);

  // ── 1. the devDependency ──────────────────────────────────────────────────
  // First, because the package manager rewrites package.json and would drop the
  // dev-script edit if it ran after it.
  if (manifest !== undefined) {
    const present = { ...manifest.dependencies, ...manifest.devDependencies };
    const wanted =
      local === undefined
        ? { [EMBED]: EMBED, [BRIDGE]: BRIDGE }
        : {
            [EMBED]: localSpec(manager, path.join(local, "packages", "embed")),
            [BRIDGE]: localSpec(manager, path.join(local, "packages", "bridge")),
          };
    const packages = Object.fromEntries(
      Object.entries(wanted).filter(([name]) => present[name] === undefined),
    );

    if (Object.keys(packages).length > 0) {
      const command = installArgv(manager, Object.values(packages));
      const exitedOk = await install({ manager, command, packages, cwd: project });

      // Whatever the exit code said, package.json on disk is now the package
      // manager's, not ours: re-read it, or the dev-script edit below would
      // stringify a stale object over the dependencies it just added.
      manifest = (await reparse(manifestFile)) ?? manifest;

      const now = { ...manifest.dependencies, ...manifest.devDependencies };
      const landed = Object.keys(packages).filter((name) => now[name] !== undefined);
      if (landed.length === Object.keys(packages).length) {
        changed.push(`installed ${landed.join(" and ")} (${manager})`);
      } else {
        // The manifest, not the exit code, is the truth here: pnpm exits
        // non-zero on things like ignored build scripts having installed fine.
        skipped.push(
          `the install ${exitedOk ? "did not add the package" : "failed"} — run it yourself:` +
            `\n    ${command.join(" ")}`,
        );
      }
    }
  }

  // ── 2. the skill ──────────────────────────────────────────────────────────
  const skillSource = options.skillSource ?? (await resolveSkillSource(local));
  if (skillSource === undefined) {
    skipped.push("could not find the shipped skills/fix-ui directory to copy");
  } else {
    const written = await copyTree(skillSource, path.join(project, ".claude", "skills", "fix-ui"));
    if (written.length > 0) changed.push(".claude/skills/fix-ui/ (the fix-ui skill)");
  }

  // ── 3. .mcp.json ──────────────────────────────────────────────────────────
  const server =
    local === undefined
      ? { command: "npx", args: [BRIDGE] }
      : { command: "node", args: [path.join(local, "packages", "bridge", "dist", "cli.js")] };
  const mcpFile = path.join(project, ".mcp.json");
  const mcpRaw = await readText(mcpFile);
  if (mcpRaw === undefined) {
    await writeFile(mcpFile, `${JSON.stringify({ mcpServers: { fixui: server } }, undefined, 2)}\n`);
    changed.push(".mcp.json (the fixui MCP server)");
  } else {
    let parsed: { mcpServers?: Record<string, unknown> } | undefined;
    try {
      parsed = JSON.parse(mcpRaw) as { mcpServers?: Record<string, unknown> };
    } catch {
      skipped.push(
        `.mcp.json is not valid JSON — left untouched; add the "fixui" server by hand:` +
          `\n    ${JSON.stringify(server)}`,
      );
    }
    if (parsed !== undefined) {
      if (parsed.mcpServers?.fixui !== undefined) {
        // A configured entry is a decision someone made; ours is not better.
      } else {
        parsed.mcpServers = { ...parsed.mcpServers, fixui: server };
        const indent = detectIndent(mcpRaw);
        const text = JSON.stringify(parsed, undefined, indent);
        await writeFile(mcpFile, mcpRaw.endsWith("\n") ? `${text}\n` : text);
        changed.push(".mcp.json (the fixui MCP server, alongside the existing ones)");
      }
    }
  }

  // ── 4. CLAUDE.md ──────────────────────────────────────────────────────────
  const claudeFile = path.join(project, "CLAUDE.md");
  const claudeRaw = (await readText(claudeFile)) ?? "";
  if (!claudeRaw.includes(CLAUDE_MARKER)) {
    const separator = claudeRaw === "" ? "" : claudeRaw.endsWith("\n\n") ? "" : claudeRaw.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(claudeFile, `${claudeRaw}${separator}${CLAUDE_LINE}\n`);
    changed.push("CLAUDE.md (the fix-ui line)");
  }

  // ── 5. .gitignore ─────────────────────────────────────────────────────────
  const ignoreFile = path.join(project, ".gitignore");
  const ignoreRaw = (await readText(ignoreFile)) ?? "";
  const listed = new Set(ignoreRaw.split("\n").map((line) => line.trim()));
  const missing = IGNORES.filter((entry) => !listed.has(entry));
  if (missing.length > 0) {
    const separator = ignoreRaw === "" || ignoreRaw.endsWith("\n") ? "" : "\n";
    await writeFile(ignoreFile, `${ignoreRaw}${separator}${missing.join("\n")}\n`);
    changed.push(`.gitignore (${missing.join(", ")})`);
  }

  // ── 6a. the lifetime edit: wrap the dev script ────────────────────────────
  const stack = await detectStack(project, manifest);
  if (manifest !== undefined) {
    const dev = manifest.scripts?.dev;
    if (dev === undefined) {
      skipped.push(
        'no "dev" script to wrap — start your dev server as `fixui dev -- <your dev command>`',
      );
    } else if (!/^\s*(?:npx\s+)?fixui(?:-bridge)?\s+dev\b/.test(dev)) {
      // Read again and edit *that*: the only version of this file safe to write
      // back is the one on disk now, whatever the package manager did to it.
      const raw = await readFile(manifestFile, "utf8");
      const current = await reparse(manifestFile);
      if (current?.scripts?.dev !== dev) {
        skipped.push(
          `package.json changed underneath us — wrap the dev script as` +
            ` \`fixui dev -- ${dev}\` yourself`,
        );
      } else {
        current.scripts.dev = `fixui dev -- ${dev}`;
        const text = JSON.stringify(current, undefined, detectIndent(raw));
        await writeFile(manifestFile, raw.endsWith("\n") ? `${text}\n` : text);
        manifest = current;
        changed.push(`package.json: dev → "fixui dev -- ${dev}"`);
      }
    }
  }

  // ── 6b. the injection edit: the shipped adapter ───────────────────────────
  if (stack === "next-app") {
    const relative = await findLayout(project);
    const file = path.join(project, relative!);
    const source = await readFile(file, "utf8");
    if (source.includes("FixUiScript")) {
      // Already wired.
    } else {
      const edited = withFixUiScript(source);
      if (edited === undefined) {
        skipped.push(
          `${relative} does not have exactly one </body> — add \`${NEXT_IMPORT}\`` +
            " and render `<FixUiScript />` last inside <body> yourself",
        );
      } else {
        await writeFile(file, edited);
        changed.push(`${relative}: <FixUiScript /> inside <body>`);
      }
    }

    const configName = await findConfig(project, NEXT_CONFIGS);
    if (configName === undefined) {
      await writeFile(path.join(project, "next.config.mjs"), NEW_NEXT_CONFIG);
      changed.push(`next.config.mjs: transpilePackages ${literal(TRANSPILE)}`);
    } else {
      const file = path.join(project, configName);
      const source = await readFile(file, "utf8");
      const edited = withTranspilePackages(source);
      if (edited === undefined) {
        skipped.push(
          `${configName}: could not add transpilePackages — add ${literal(TRANSPILE)}` +
            " to it by hand, or the embed's raw TypeScript will not build",
        );
      } else if (edited !== source) {
        await writeFile(file, edited);
        changed.push(`${configName}: transpilePackages ${literal(TRANSPILE)}`);
      }
    }
  } else if (stack === "vite") {
    const configName = await findConfig(project, VITE_CONFIGS);
    if (configName === undefined) {
      skipped.push(`no vite.config.* found — add \`${VITE_IMPORT}\` and fixui() to plugins`);
    } else {
      const file = path.join(project, configName);
      const source = await readFile(file, "utf8");
      if (!source.includes("@hulbu/fixui/vite")) {
        const edited = withVitePlugin(source);
        if (edited === undefined) {
          skipped.push(
            `${configName} has no plugins array we could read — add \`${VITE_IMPORT}\`` +
              " and fixui() to plugins yourself",
          );
        } else {
          await writeFile(file, edited);
          changed.push(`${configName}: fixui() in plugins`);
        }
      }
    }
  }

  // ── 7. say what happened, and the one thing to do next ────────────────────
  const nextStep =
    stack === "next-app" || stack === "vite"
      ? "run your dev server (`npm run dev`) and open the app — a fix-ui chip should appear."
      : "wire the adapter above into your app, then run your dev server and confirm the chip appears.";

  log(changed.length === 0 ? "fixui init: already set up — nothing to change." : "fixui init changed:");
  for (const line of changed) log(`  ✓ ${line}`);
  if (skipped.length > 0) {
    log("\nskipped (do these by hand):");
    for (const line of skipped) log(`  • ${line}`);
  }
  if (stack !== "next-app" && stack !== "vite") {
    log(
      `\n${stack === "next-pages" ? "Next (pages router)" : "This project's framework"} is not` +
        " one we edit automatically. Pick the adapter:\n" +
        ADAPTER_TABLE,
    );
  }
  log(`\nNext: ${nextStep}`);

  return { stack, manager, changed, skipped, nextStep };
}
