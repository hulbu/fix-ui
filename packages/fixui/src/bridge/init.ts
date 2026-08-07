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

/**
 * The one package: the adapters the app imports *and* the `fixui` bin the
 * wrapped dev script calls. One name, so there is no version pin between two
 * published things that can ever disagree — the failure that made the first
 * publish uninstallable.
 */
const PACKAGE = "fixui";

/**
 * The packages Next is told to transpile.
 *
 * It ships compiled ESM with declarations, so this is no longer the load
 * bearing thing it once was — it is kept because a *local* install is a tarball
 * of a working tree, and because Next's handling of a dependency it compiles
 * itself is the path this integration has actually been exercised on. Writing it
 * costs an app nothing; discovering it was needed costs an afternoon.
 */
const TRANSPILE = [PACKAGE];

const IGNORES = [".fix-ui.json", ".fix-ui.jsonl", ".fix-ui.reviews.jsonl"];

/** "a", "a and b", "a, b and c" — a list a person would read aloud. */
function list(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}

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
  /**
   * Everything init could not finish, written as instructions to an agent and
   * ready to paste. `undefined` — and only then — means the project is wired.
   */
  agentPrompt?: string;
  /** The single thing to do next. */
  nextStep: string;
}

/**
 * Work that is left, phrased for the agent that will do it.
 *
 * Kept beside `skipped` rather than derived from it, because the two audiences
 * are different: `skipped` tells a person what init declined to touch, and this
 * tells an agent what to do about it, in the imperative, naming the file. It is
 * also *wider* than `skipped` — a Next pages-router app is edited successfully
 * and still is not finished (the client adapter cannot discover the bridge),
 * and saying nothing there would be declaring victory on a chip that quietly
 * queues notes.
 */
type Todo = string[];

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
 * The shipped `skills/fix-ui/` directory.
 *
 * It lives at the root of this package — `packages/fixui/skills/fix-ui` in the
 * repo, `<install>/skills/fix-ui` once npm has unpacked the tarball — and this
 * module lives one directory below it in both trees (`src/bridge/init.ts`,
 * `dist/bridge/init.js`). So the same `../../skills/fix-ui`, relative to this
 * module, finds it in either place. That is the point: a repo-relative path
 * would resolve to nothing at all for someone who installed from npm, and
 * `init` would silently copy no skill.
 *
 * `undefined` means we have no skill to copy, which is reported rather than
 * papered over.
 */
export async function resolveSkillSource(local?: string): Promise<string | undefined> {
  const here = fileURLToPath(new URL(".", import.meta.url)); // src/bridge/ or dist/bridge/
  const candidates = [
    ...(local === undefined ? [] : [path.join(local, "packages", "fixui", "skills", "fix-ui")]),
    path.join(here, "..", "..", "skills", "fix-ui"),
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `@scope/name` → `scope-name`, the way a packed tarball is named. */
function slug(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * The tarball `make package` writes into `<repo>/dist`, as an install specifier.
 *
 * A local checkout is *copied in*, never linked. `link:`/`file:` at a directory
 * points node_modules outside the project tree, and every bundler with a
 * compile root (Turbopack, Vite's `fs.allow`) then refuses the import — first in
 * dev, then again in the production build. A tarball is extracted into
 * node_modules like any other package, so none of that arises. `undefined`
 * means the checkout has not been packed, which is reported, never worked
 * around: falling back to a link would trade a clear error for a confusing one.
 */
async function resolveTarballs(repo: string): Promise<Record<string, string> | undefined> {
  const dist = path.join(repo, "dist");
  const entries = await readdir(dist).catch(() => [] as string[]);
  const found: Record<string, string> = {};
  for (const name of [PACKAGE]) {
    // `-<digit>` is what separates the name from the version, so a neighbouring
    // `fixui-extension-0.1.0.tgz` could never be mistaken for this one.
    const pattern = new RegExp(`^${escapeRegExp(slug(name))}-\\d[^\\s]*\\.tgz$`);
    const match = entries.filter((entry) => pattern.test(entry)).sort();
    const newest = match[match.length - 1];
    if (newest === undefined) return undefined;
    found[name] = `file:${path.join(dist, newest)}`;
  }
  return found;
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

// ── workspaces ──────────────────────────────────────────────────────────────

/**
 * The globs a monorepo root declares, or `undefined` if this is not a
 * workspace. Both declarations are read: pnpm's own file, and the `workspaces`
 * field npm and yarn use.
 */
async function workspaceGlobs(
  project: string,
  manifest: Manifest | undefined,
): Promise<string[] | undefined> {
  const yaml = await readText(path.join(project, "pnpm-workspace.yaml"));
  if (yaml !== undefined) {
    const globs = yamlPackages(yaml);
    if (globs.length > 0) return globs;
  }
  const field = manifest?.workspaces as string[] | { packages?: string[] } | undefined;
  const globs = Array.isArray(field) ? field : field?.packages;
  return globs === undefined || globs.length === 0 ? undefined : globs;
}

/**
 * The `packages:` list out of pnpm-workspace.yaml, by hand: the file is a
 * two-level document written by people, and a YAML parser is a dependency this
 * one list does not justify. Anything unrecognised yields no globs, which reads
 * downstream as "not a workspace" — the pre-existing behaviour.
 */
function yamlPackages(source: string): string[] {
  const globs: string[] = [];
  let inside = false;
  for (const line of source.split("\n")) {
    const key = /^([\w-]+)\s*:/.exec(line);
    if (key !== null) {
      inside = key[1] === "packages";
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!inside || item === null) continue;
    const value = item[1]!.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (value !== "") globs.push(value);
  }
  return globs;
}

const NEVER_WALK = new Set(["node_modules", ".git", "dist", "build"]);

/** Every directory under `dir`, itself included, minus the ones nothing lives in. */
async function descend(dir: string, depth = 4): Promise<string[]> {
  const out = [dir];
  if (depth === 0) return out;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || NEVER_WALK.has(entry.name)) continue;
    out.push(...(await descend(path.join(dir, entry.name), depth - 1)));
  }
  return out;
}

/** The directories a workspace glob names. `*` matches within one segment. */
async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
  let dirs = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (segment === "**") {
        next.push(...(await descend(dir)));
      } else if (!segment.includes("*")) {
        next.push(path.join(dir, segment));
      } else {
        const test = new RegExp(`^${segment.split("*").map(escapeRegExp).join("[^/]*")}$`);
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.isDirectory() && !NEVER_WALK.has(entry.name) && test.test(entry.name)) {
            next.push(path.join(dir, entry.name));
          }
        }
      }
    }
    dirs = next;
  }
  return dirs;
}

/**
 * The workspace packages that render an app — the ones whose package.json has
 * `next` or `vite`, because those are the packages that will import the embed.
 * The dependency has to live in *that* package: with pnpm's isolated
 * node_modules a root-level install is simply not on the app's resolution path.
 */
async function findAppPackages(
  project: string,
  globs: string[],
): Promise<{ dir: string; name: string }[]> {
  const seen = new Set<string>();
  const found: { dir: string; name: string }[] = [];
  for (const glob of globs) {
    if (glob.startsWith("!")) continue; // an exclusion; we are not enumerating exhaustively
    for (const dir of await expandGlob(project, glob)) {
      if (dir === project || seen.has(dir)) continue;
      seen.add(dir);
      const manifest = await reparse(path.join(dir, "package.json"));
      if (manifest === undefined) continue;
      const deps = { ...manifest.dependencies, ...manifest.devDependencies };
      if (deps.next === undefined && deps.vite === undefined) continue;
      const name = typeof manifest.name === "string" ? manifest.name : path.relative(project, dir);
      found.push({ dir, name });
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

// ── adding the dependencies ─────────────────────────────────────────────────

interface AddOptions {
  /** The package to install into — a workspace member, or the project root. */
  dir: string;
  /** The manifest of `dir`, as last read. */
  manifest: Manifest;
  /** name → specifier. Already-present names are dropped, so a rerun is a no-op. */
  wanted: Record<string, string>;
  manager: PackageManager;
  install: Installer;
  /** How to name this package in a sentence: "" for the root, " in website". */
  where: string;
  /** What a person would have to type first to be in `dir`. */
  prefix: string;
  changed: string[];
  skipped: string[];
  todo: Todo;
}

/** Installs what is missing, and returns the manifest as it is on disk after. */
async function addDependencies(options: AddOptions): Promise<Manifest> {
  const { dir, wanted, manager, install, where, prefix, changed, skipped, todo } = options;
  let manifest = options.manifest;
  const present = { ...manifest.dependencies, ...manifest.devDependencies };
  const packages = Object.fromEntries(
    Object.entries(wanted).filter(([name]) => present[name] === undefined),
  );
  if (Object.keys(packages).length === 0) return manifest;

  const command = installArgv(manager, Object.values(packages));
  const exitedOk = await install({ manager, command, packages, cwd: dir });

  // Whatever the exit code said, package.json on disk is now the package
  // manager's, not ours: re-read it, or the dev-script edit below would
  // stringify a stale object over the dependencies it just added.
  manifest = (await reparse(path.join(dir, "package.json"))) ?? manifest;

  const now = { ...manifest.dependencies, ...manifest.devDependencies };
  const landed = Object.keys(packages).filter((name) => now[name] !== undefined);
  if (landed.length === Object.keys(packages).length) {
    changed.push(`installed ${list(landed)}${where} (${manager})`);
  } else {
    // The manifest, not the exit code, is the truth here: pnpm exits
    // non-zero on things like ignored build scripts having installed fine.
    skipped.push(
      `the install ${exitedOk ? "did not add the package" : "failed"}${where} — run it yourself:` +
        `\n    ${prefix}${command.join(" ")}`,
    );
    todo.push(
      `Install the package — init's own attempt${where} did not land it. Run:` +
        ` ${prefix}${command.join(" ")}`,
    );
  }
  return manifest;
}

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

const NEXT_IMPORT = 'import { FixUiScript } from "fixui/next";';

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
  // Compiled by Next along with the app — see TRANSPILE in init.ts.
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

// ── source edits: Next, pages router ────────────────────────────────────────

/**
 * The pages router gets `<FixUi />` from `fixui/react`, not `<FixUiScript />`:
 * the Next adapter is an async server component and the pages router cannot
 * render one. The cost is that this variant is a *client* component and so
 * cannot read `.fix-ui.json` — it falls back to the default bridge URL, which
 * is why wiring it is not the same as finishing (see the todo we raise).
 */
const PAGES_IMPORT = 'import { FixUi } from "fixui/react";';

const PAGES_APPS = ["pages", "src/pages"].flatMap((dir) =>
  ["tsx", "jsx", "ts", "js"].map((extension) => `${dir}/_app.${extension}`),
);

/** `return <Component {...pageProps} />;` — the shape a custom App is written
 *  in. One element, self-closing, nothing nested: anything else is not this. */
const SINGLE_RETURN = /(\breturn\s*\(?\s*)(<[A-Z][\w.]*(?:\s[^<>]*?)?\/>)(\s*\)?\s*;?)/g;

/**
 * `<FixUi />` beside whatever the App already renders — inside the fragment it
 * has, or inside one we wrap its single element in. Exactly one of each shape,
 * for the same reason as `</body>`: two means we would be picking one.
 */
function withFixUiComponent(source: string): string | undefined {
  const fragments = [...source.matchAll(/<\/>/g)];
  if (fragments.length === 1) {
    const close = fragments[0]!.index;
    const lineStart = source.lastIndexOf("\n", close) + 1;
    const before = source.slice(lineStart, close);
    const inserted =
      before.trim() === ""
        ? `${source.slice(0, lineStart)}${before}  <FixUi />\n${source.slice(lineStart)}`
        : `${source.slice(0, close)}<FixUi />${source.slice(close)}`;
    return withImport(inserted, PAGES_IMPORT);
  }
  if (fragments.length > 1) return undefined;

  const returns = [...source.matchAll(SINGLE_RETURN)];
  if (returns.length !== 1) return undefined;
  const match = returns[0]!;
  const indent = indentOf(source, match.index);
  const wrapped =
    `return (\n${indent}  <>\n${indent}    ${match[2]!}\n${indent}    <FixUi />\n` +
    `${indent}  </>\n${indent});`;
  return withImport(
    source.slice(0, match.index) + wrapped + source.slice(match.index + match[0].length),
    PAGES_IMPORT,
  );
}

// ── source edits: Vite ──────────────────────────────────────────────────────

const VITE_IMPORT = 'import { fixui } from "fixui/vite";';

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
  "  Next (app router)   import { FixUiScript } from \"fixui/next\"",
  "                      → render <FixUiScript /> last inside <body> in app/layout.tsx",
  "  Next (pages router) import { FixUi } from \"fixui/react\"",
  "                      → render <FixUi /> beside <Component …> in pages/_app.tsx",
  "  Vite                import { fixui } from \"fixui/vite\"",
  "                      → add fixui() to plugins in vite.config.*",
  "  plain HTML          <script src=\"…/fixui/dist/fixui.global.js\" data-port … data-token …>",
  "  anything else       call initFixUi() from \"fixui\" in a dev-only entry point",
].join("\n");

/** The adapter reference init copies in, named wherever the agent is sent to it. */
const ADAPTERS_DOC = ".claude/skills/fix-ui/adapters.md";

// ── the prompt to paste, for the work init could not finish ─────────────────

/**
 * The paste-ready block.
 *
 * When init stops short, the developer's next move is to tell an agent to
 * finish — and the difference between a good and a wasted twenty minutes is
 * whether that agent is handed the specifics init already knows (which package
 * renders the app, which file it could not parse) or has to rediscover them. So
 * this is the actual words, not a link to them, and it names what is actually
 * left rather than describing the whole job.
 */
const PROMPT_TITLE = "Paste this to your agent";

const PROMPT_LEAD =
  "Wire fix-ui into this project. `fixui init` has already done what it could;" +
  " this is what is left.";

const PROMPT_CLOSE =
  "Then start the dev server and tell me whether the fix-ui chip appears" +
  " bottom-right on the page.";

/** The prompt as plain text — paragraphs, in the order they must be done. */
function composePrompt(todo: Todo): string | undefined {
  if (todo.length === 0) return undefined;
  return [PROMPT_LEAD, ...todo, PROMPT_CLOSE].join("\n\n");
}

/** Wrapped at `width`, never mid-word: a path split across two lines is a path
 *  that pastes back broken. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((one) => one !== "")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The prompt, drawn — so it is obvious where the thing to copy begins and ends. */
function drawPrompt(prompt: string): string {
  const paragraphs = prompt.split("\n\n").map((one) => wrap(one, 58));
  const body: string[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0) body.push("");
    body.push(...paragraph);
  }
  // A word longer than the wrap width (a long path) widens the box rather than
  // being broken in half.
  const width = Math.max(58, ...body.map((line) => line.length), PROMPT_TITLE.length + 2);
  return [
    `┌─ ${PROMPT_TITLE} ${"─".repeat(width + 2 - PROMPT_TITLE.length - 3)}┐`,
    ...body.map((line) => `│ ${line.padEnd(width)} │`),
    `└${"─".repeat(width + 2)}┘`,
  ].join("\n");
}

/** What the thing does, once it is wired — the part a link would not tell you. */
const HOW_TO_USE = [
  "How to use it:",
  "  1. with the dev server running, press the fix-ui chip and point at what is wrong",
  "  2. type what should change, and send it",
  "  3. tell your agent `fix ui` — it reads your notes and works through them",
  "",
  "  Your agent can also ask you to check its own work: a review banner appears on",
  "  the page, and each answer goes straight back to it.",
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

async function findLayout(dir: string): Promise<string | undefined> {
  for (const where of ["app", "src/app"]) {
    for (const extension of ["tsx", "jsx", "ts", "js"]) {
      const relative = path.join(where, `layout.${extension}`);
      if (await fileExists(path.join(dir, relative))) return relative;
    }
  }
  return undefined;
}

// ── the injection edit, wherever the app actually lives ─────────────────────

/**
 * The one edit that has to happen *in the package that renders the app*.
 *
 * In a single-package project that is the project. In a workspace it is the
 * member that depends on `next` or `vite` — the same package the dependency
 * goes in, and for the same reason: an adapter imported from a package that
 * cannot resolve it is not wired, it is broken. (The *lifetime* edit is the
 * opposite: it stays at the root, because one bridge covers the whole repo.)
 */
interface Edits {
  /** The project root: every path is reported relative to it. */
  project: string;
  /** The package that renders the app. */
  dir: string;
  changed: string[];
  skipped: string[];
  todo: Todo;
}

/** How a file under the app package is named in a sentence — "app/layout.tsx"
 *  at the root, "website/app/layout.tsx" a package below it. */
function shown(edits: Edits, relative: string): string {
  const full = path.relative(edits.project, path.join(edits.dir, relative));
  return full.split(path.sep).join("/");
}

async function injectNextLayout(edits: Edits): Promise<void> {
  const relative = await findLayout(edits.dir);
  if (relative === undefined) return; // detectStack found one; nothing to do if it is gone
  const name = shown(edits, relative);
  const file = path.join(edits.dir, relative);
  const source = await readFile(file, "utf8");
  if (source.includes("FixUiScript")) return;

  const edited = withFixUiScript(source);
  if (edited === undefined) {
    edits.skipped.push(
      `${name} does not have exactly one </body> — add \`${NEXT_IMPORT}\`` +
        " and render `<FixUiScript />` last inside <body> yourself",
    );
    edits.todo.push(
      `In ${name}, add \`${NEXT_IMPORT}\` and render \`<FixUiScript />\` as the last` +
        " thing inside <body>. init left that file alone because it does not have exactly" +
        ` one </body> and it will not guess. ${ADAPTERS_DOC} has the shape.`,
    );
    return;
  }
  await writeFile(file, edited);
  edits.changed.push(`${name}: <FixUiScript /> inside <body>`);
}

async function injectPagesApp(edits: Edits): Promise<void> {
  const relative = await findConfig(edits.dir, PAGES_APPS);
  if (relative === undefined) {
    edits.skipped.push(
      `no ${shown(edits, "pages/_app.tsx")} to edit — create one, add` +
        ` \`${PAGES_IMPORT}\` and render \`<FixUi />\` beside <Component {...pageProps} />`,
    );
    edits.todo.push(
      `This is a Next pages-router app and it has no ${shown(edits, "pages/_app.tsx")}.` +
        ` Create one, add \`${PAGES_IMPORT}\` and render \`<FixUi />\` beside` +
        ` <Component {...pageProps} /> — ${ADAPTERS_DOC} has the shape.`,
    );
    return;
  }

  const name = shown(edits, relative);
  const file = path.join(edits.dir, relative);
  const source = await readFile(file, "utf8");
  const already = source.includes("fixui/react") || source.includes("<FixUi ");
  if (!already) {
    const edited = withFixUiComponent(source);
    if (edited === undefined) {
      edits.skipped.push(
        `${name} is not a shape we can edit safely — add \`${PAGES_IMPORT}\`` +
          " and render `<FixUi />` beside <Component {...pageProps} /> yourself",
      );
      edits.todo.push(
        `In ${name}, add \`${PAGES_IMPORT}\` and render \`<FixUi />\` beside` +
          " <Component {...pageProps} />, inside a fragment. init left the file alone" +
          ` because it could not read its return shape. ${ADAPTERS_DOC} has the example.`,
      );
      return;
    }
    await writeFile(file, edited);
    edits.changed.push(`${name}: <FixUi /> beside the page`);
  }

  // Wired, and still not finished — said on every run, because it is a property
  // of the pages-router adapter rather than of this one.
  edits.todo.push(
    `${name} renders <FixUi /> from fixui/react. That adapter is a client component,` +
      " so unlike the app-router one it cannot read .fix-ui.json and falls back to" +
      " http://127.0.0.1:3499. Start the dev server, leave a note, and check it reaches" +
      " the inbox; if it does not, either pin the bridge to that port (`fixui dev --port" +
      " 3499 -- …` in the root dev script) or pass bridgeUrl and token to <FixUi />" +
      ` explicitly — ${ADAPTERS_DOC} explains both.`,
  );
}

/** Both Next routers need it: the embed is compiled along with the app. */
async function injectNextConfig(edits: Edits): Promise<void> {
  const configName = await findConfig(edits.dir, NEXT_CONFIGS);
  if (configName === undefined) {
    await writeFile(path.join(edits.dir, "next.config.mjs"), NEW_NEXT_CONFIG);
    edits.changed.push(`${shown(edits, "next.config.mjs")}: transpilePackages ${literal(TRANSPILE)}`);
    return;
  }

  const name = shown(edits, configName);
  const file = path.join(edits.dir, configName);
  const source = await readFile(file, "utf8");
  const edited = withTranspilePackages(source);
  if (edited === undefined) {
    edits.skipped.push(
      `${name}: could not add transpilePackages — add ${literal(TRANSPILE)}` +
        " to it by hand if the embed fails to compile",
    );
    edits.todo.push(
      `In ${name}, add ${literal(TRANSPILE)} to transpilePackages. init could not read` +
        " the shape it is written in, and without it the import fails inside node_modules.",
    );
  } else if (edited !== source) {
    await writeFile(file, edited);
    edits.changed.push(`${name}: transpilePackages ${literal(TRANSPILE)}`);
  }
}

async function injectVitePlugin(edits: Edits): Promise<void> {
  const configName = await findConfig(edits.dir, VITE_CONFIGS);
  if (configName === undefined) {
    edits.skipped.push(`no vite.config.* found — add \`${VITE_IMPORT}\` and fixui() to plugins`);
    edits.todo.push(
      `This is a Vite app with no vite.config.* that init could find${
        edits.dir === edits.project ? "" : ` in ${shown(edits, ".")}`
      }. Add one with \`${VITE_IMPORT}\` and fixui() in plugins — ${ADAPTERS_DOC} has the shape.`,
    );
    return;
  }

  const name = shown(edits, configName);
  const file = path.join(edits.dir, configName);
  const source = await readFile(file, "utf8");
  if (source.includes("fixui/vite")) return;

  const edited = withVitePlugin(source);
  if (edited === undefined) {
    edits.skipped.push(
      `${name} has no plugins array we could read — add \`${VITE_IMPORT}\`` +
        " and fixui() to plugins yourself",
    );
    edits.todo.push(
      `In ${name}, add \`${VITE_IMPORT}\` and put fixui() in the plugins array. init left` +
        " the file alone because it could not tell which plugins array was Vite's own.",
    );
    return;
  }
  await writeFile(file, edited);
  edits.changed.push(`${name}: fixui() in plugins`);
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const { project, local, log } = options;
  const install = options.install ?? shellInstall;
  const changed: string[] = [];
  const skipped: string[] = [];
  const todo: Todo = [];

  const manifestFile = path.join(project, "package.json");
  const manifestRaw = await readText(manifestFile);
  let manifest: Manifest | undefined;
  if (manifestRaw === undefined) {
    skipped.push("no package.json here — the dependency and the dev script are yours to add");
    todo.push(
      `There is no package.json here, so init could not install ${PACKAGE} or wrap the dev` +
        ` script. Install it, start the dev server as \`fixui dev -- <your dev command>\`,` +
        ` then read ${ADAPTERS_DOC}, pick the adapter for this stack and make the injection edit.`,
    );
  } else {
    try {
      manifest = JSON.parse(manifestRaw) as Manifest;
    } catch {
      skipped.push(
        "package.json is not valid JSON — left untouched;" +
          ` install ${PACKAGE} and wrap the dev script as \`fixui dev -- <your dev command>\` yourself`,
      );
      todo.push(
        "package.json here is not valid JSON, so init touched none of it. Fix it, install" +
          ` ${PACKAGE}, wrap the dev script as \`fixui dev -- <your dev command>\`, then read` +
          ` ${ADAPTERS_DOC} and make the injection edit.`,
      );
    }
  }

  const manager = await detectManager(project);

  // ── 0. which package renders the app ──────────────────────────────────────
  // Everything package-shaped below hangs off this: the dependency and the
  // injection edit both belong to the package that imports the adapter, and in
  // a workspace that is not the root. Guessing it wrong is the twenty minutes
  // this command exists to save, so where it cannot be known the answer is
  // "none" and init says which packages it looked at.
  const globs = manifest === undefined ? undefined : await workspaceGlobs(project, manifest);
  const apps = globs === undefined ? [] : await findAppPackages(project, globs);
  const app = apps.length === 1 ? apps[0] : undefined;
  const rootRenders =
    manifest !== undefined &&
    ["next", "vite"].some(
      (name) =>
        manifest?.dependencies?.[name] !== undefined ||
        manifest?.devDependencies?.[name] !== undefined,
    );
  /** Where the injection edit goes, or `undefined` for "we will not guess". */
  const appDir =
    globs === undefined
      ? project
      : (app?.dir ?? (apps.length === 0 && rootRenders ? project : undefined));

  if (globs !== undefined && appDir === undefined) {
    const candidates = apps.map((one) => one.name);
    skipped.push(
      (apps.length === 0
        ? "this is a workspace and no package depends on next or vite, so"
        : `this is a workspace and ${list(candidates)} could each be the app, so`) +
        ` ${PACKAGE} went in at the root only and no adapter was inserted — add it to the` +
        " package that renders your app and make the adapter edit there",
    );
    todo.push(
      (apps.length === 0
        ? "This is a workspace and no package in it depends on next or vite, so init could" +
          " not tell which one renders the UI."
        : `This is a workspace and ${list(candidates)} could each be the app` +
          ` (${list(apps.map((one) => path.relative(project, one.dir)))}), so init edited` +
          " neither rather than guess.") +
        ` Pick the package that renders the UI, install ${PACKAGE} in it` +
        ` (\`${installArgv(manager, [PACKAGE]).join(" ")}\` from that directory — a root-level` +
        ` install is not on its resolution path), then read ${ADAPTERS_DOC}, pick the adapter` +
        " for that stack and make the injection edit in that package. The root dev script is" +
        " already wrapped, and one bridge covers the whole repo, so leave it alone.",
    );
  }

  // ── 1. the devDependency ──────────────────────────────────────────────────
  // First, because the package manager rewrites package.json and would drop the
  // dev-script edit if it ran after it.
  //
  // One package, but in a workspace it can need two homes. The adapters are
  // imported by the app, so the package has to be on *that* package's
  // resolution path; the `fixui` bin is called by the root dev script, so it
  // has to be at the root too. With pnpm's isolated node_modules neither
  // install covers the other.
  const tarballs = local === undefined ? undefined : await resolveTarballs(local);
  if (local !== undefined && tarballs === undefined) {
    skipped.push(
      `no packed tarballs in ${path.join(local, "dist")} — run \`make package\` there first,` +
        " then rerun this command. init will not fall back to a link: into that checkout:" +
        " it resolves outside this project's tree, which breaks the production build" +
        " and cannot be installed on CI",
    );
    todo.push(
      `The fix-ui checkout at ${local} has not been packed, so nothing was installed. Run` +
        ` \`make package\` there, then rerun \`npx fixui init --local ${local}\` here.`,
    );
  }

  if (manifest !== undefined && (local === undefined || tarballs !== undefined)) {
    const wanted: Record<string, string> = {
      [PACKAGE]: tarballs === undefined ? PACKAGE : tarballs[PACKAGE]!,
    };

    // The root always: that is where the wrapped `dev` script runs, and the
    // `fixui` bin has to be findable from there.
    manifest = await addDependencies({
      dir: project,
      manifest,
      wanted,
      manager,
      install,
      where: "",
      prefix: "",
      changed,
      skipped,
      todo,
    });

    // And the app package as well, when there is exactly one and we are sure
    // which: that is where `import … from "fixui/next"` is resolved.
    if (app !== undefined) {
      const appManifest = await reparse(path.join(app.dir, "package.json"));
      const relative = path.relative(project, app.dir);
      if (appManifest !== undefined) {
        await addDependencies({
          dir: app.dir,
          manifest: appManifest,
          wanted,
          manager,
          install,
          where: ` in ${app.name}`,
          prefix: `cd ${relative} && `,
          changed,
          skipped,
          todo,
        });
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
      ? { command: "npx", args: [PACKAGE] }
      : {
          command: "node",
          args: [path.join(local, "packages", "fixui", "dist", "bridge", "cli.js")],
        };
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
      todo.push(
        `.mcp.json here is not valid JSON, so init left it alone. Fix it and add the "fixui"` +
          ` MCP server to mcpServers: ${JSON.stringify(server)} — without it you have the` +
          " picker but I cannot read the notes.",
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

  // ── 6a. the lifetime edit: wrap the ROOT dev script ───────────────────────
  // The root even in a workspace: one bridge covers every app in the repo, and
  // wrapping each package's own dev script instead gives you several bridges
  // racing for one inbox.
  const appManifest =
    app === undefined ? manifest : await reparse(path.join(app.dir, "package.json"));
  const stack = appDir === undefined ? "unknown" : await detectStack(appDir, appManifest);
  if (manifest !== undefined) {
    const dev = manifest.scripts?.dev;
    if (dev === undefined) {
      skipped.push(
        'no "dev" script to wrap — start your dev server as `fixui dev -- <your dev command>`',
      );
      todo.push(
        "There is no dev script at the repo root for init to wrap. Start the dev server as" +
          " `fixui dev -- <your dev command>` (or add that as the root dev script) — without" +
          " it there is no bridge and notes queue in the browser instead of reaching me.",
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
        todo.push(
          `The root dev script was not wrapped: package.json changed while init was running.` +
            ` Set it to \`fixui dev -- ${dev}\`, which is what gives the bridge the dev` +
            " server's lifetime.",
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

  // ── 6b. the injection edit: the shipped adapter, in the app's package ─────
  if (appDir !== undefined) {
    const edits: Edits = { project, dir: appDir, changed, skipped, todo };
    if (stack === "next-app") {
      await injectNextLayout(edits);
      await injectNextConfig(edits);
    } else if (stack === "next-pages") {
      await injectPagesApp(edits);
      await injectNextConfig(edits);
    } else if (stack === "vite") {
      await injectVitePlugin(edits);
    } else if (manifest !== undefined) {
      // A project we recognise as a project, built with something we do not
      // ship an adapter edit for. The table below says what the options are;
      // the prompt says it in the form an agent can act on.
      todo.push(
        "init could not tell what this project renders with — no next or vite dependency" +
          ` where it looked${appDir === project ? "" : ` (${shown(edits, ".")})`}. Read` +
          ` ${ADAPTERS_DOC}, pick the adapter for this stack, and make the injection edit.` +
          " The dev script is already wrapped, so that half is done.",
      );
    }
  }

  // ── 7. say what happened, and the one thing to do next ────────────────────
  const prompt = composePrompt(todo);
  const nextStep =
    prompt === undefined
      ? "run your dev server (`npm run dev`) and open the app — a fix-ui chip should appear."
      : "paste the prompt below to your agent — it names exactly what is left.";

  log(changed.length === 0 ? "fixui init: already set up — nothing to change." : "fixui init changed:");
  for (const line of changed) log(`  ✓ ${line}`);
  if (tarballs !== undefined) {
    // Said on every run, not just the one that installed: it is a property of
    // what package.json now says, and that outlives this command.
    log(
      `\nLocal install: the ${PACKAGE} entry points at a tarball in` +
        ` ${path.join(local!, "dist")}. That path only exists on this machine —` +
        " do not commit it, and repack after changing fix-ui.",
    );
  }
  if (skipped.length > 0) {
    log("\nskipped (do these by hand):");
    for (const line of skipped) log(`  • ${line}`);
  }
  if (stack === "unknown") {
    log(
      `\n${
        appDir === undefined
          ? "No adapter was inserted, because which package renders the app is not ours to guess."
          : "This project's framework is not one we edit automatically."
      } Pick the adapter:\n${ADAPTER_TABLE}`,
    );
  }
  log(`\n${HOW_TO_USE}`);
  log(`\nNext: ${nextStep}`);
  // Last, and drawn: it is the thing to copy, so nothing scrolls past below it.
  if (prompt !== undefined) log(`\n${drawPrompt(prompt)}`);

  return {
    stack,
    manager,
    changed,
    skipped,
    ...(prompt === undefined ? {} : { agentPrompt: prompt }),
    nextStep,
  };
}
