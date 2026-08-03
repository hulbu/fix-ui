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
/** The embed's own dependency: only ever named in local mode, where nothing is
 *  published and a registry cannot resolve it. */
const CORE = "@hulbu/fixui-core";

/** Next must transpile the embed: it ships raw TypeScript, and without this the
 *  integration fails silently rather than loudly. */
const TRANSPILE = [EMBED, "@hulbu/fixui-core"];

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `@hulbu/fixui` → `hulbu-fixui`, the way a packed tarball is named. */
function slug(name: string): string {
  return name.replace(/^@/, "").replace(/\//g, "-");
}

/**
 * The tarballs `make package` writes into `<repo>/dist`, as install specifiers.
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
  for (const name of [CORE, EMBED, BRIDGE]) {
    // `-<digit>` is what separates the name from the version: it is the only
    // thing telling `hulbu-fixui-0.0.1.tgz` from `hulbu-fixui-core-0.0.1.tgz`.
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
}

/** Installs what is missing, and returns the manifest as it is on disk after. */
async function addDependencies(options: AddOptions): Promise<Manifest> {
  const { dir, wanted, manager, install, where, prefix, changed, skipped } = options;
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

  // ── 1. the devDependencies ────────────────────────────────────────────────
  // First, because the package manager rewrites package.json and would drop the
  // dev-script edit if it ran after it.
  //
  // Two packages, two homes. The embed is imported by the app, so it belongs to
  // the package that renders the app. The bridge is run by `fixui dev`, which
  // wraps the root dev script, so it belongs at the root.
  const tarballs = local === undefined ? undefined : await resolveTarballs(local);
  if (local !== undefined && tarballs === undefined) {
    skipped.push(
      `no packed tarballs in ${path.join(local, "dist")} — run \`make package\` there first,` +
        " then rerun this command. init will not fall back to a link: into that checkout:" +
        " it resolves outside this project's tree, which breaks the production build" +
        " and cannot be installed on CI",
    );
  }

  if (manifest !== undefined && (local === undefined || tarballs !== undefined)) {
    const embedWanted: Record<string, string> =
      tarballs === undefined
        ? { [EMBED]: EMBED }
        : { [CORE]: tarballs[CORE]!, [EMBED]: tarballs[EMBED]! };
    const bridgeWanted = { [BRIDGE]: tarballs === undefined ? BRIDGE : tarballs[BRIDGE]! };

    const globs = await workspaceGlobs(project, manifest);
    const apps = globs === undefined ? [] : await findAppPackages(project, globs);
    const app = globs !== undefined && apps.length === 1 ? apps[0]! : undefined;

    if (globs !== undefined && app === undefined) {
      // Guessing which package imports the embed is worse than saying we did not.
      skipped.push(
        (apps.length === 0
          ? "this is a workspace and no package depends on next or vite, so"
          : `this is a workspace and ${list(apps.map((one) => one.name))} could each be the app, so`) +
          ` ${EMBED} went in at the root — add it to the package that renders your app` +
          " as well, or its import will not resolve there",
      );
    }

    manifest = await addDependencies({
      dir: project,
      manifest,
      wanted: app === undefined ? { ...embedWanted, ...bridgeWanted } : bridgeWanted,
      manager,
      install,
      where: "",
      prefix: "",
      changed,
      skipped,
    });

    if (app !== undefined) {
      const appManifest = await reparse(path.join(app.dir, "package.json"));
      const relative = path.relative(project, app.dir);
      if (appManifest !== undefined) {
        await addDependencies({
          dir: app.dir,
          manifest: appManifest,
          wanted: embedWanted,
          manager,
          install,
          where: ` in ${app.name}`,
          prefix: `cd ${relative} && `,
          changed,
          skipped,
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
  if (tarballs !== undefined) {
    // Said on every run, not just the one that installed: it is a property of
    // what package.json now says, and that outlives this command.
    log(
      `\nLocal install: the ${EMBED} and ${BRIDGE} entries point at tarballs in` +
        ` ${path.join(local!, "dist")}. Those paths only exist on this machine —` +
        " do not commit them, and repack after changing fix-ui.",
    );
  }
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
  log(`\n${HOW_TO_USE}`);
  log(`\nNext: ${nextStep}`);

  return { stack, manager, changed, skipped, nextStep };
}
