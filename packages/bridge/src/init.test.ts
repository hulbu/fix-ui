/**
 * `fixui init` — the whole install, run once in a target project.
 *
 * Everything here runs against a real temporary project directory, because the
 * property that matters is what is on disk afterwards: every write additive,
 * every rerun a no-op, and every edit it could not make safely reported instead
 * of guessed at. The package-manager install is the one injected seam — a test
 * that reached the network would be testing npm, not init.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSkillSource, runInit, type InitOptions, type InstallPlan } from "./init.js";

let project: string;
const tempDirs: string[] = [];

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "fixui-init-"));
  tempDirs.push(project);
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Every install this run was asked to perform. */
const installs: InstallPlan[] = [];

/** A stand-in for the package manager that does what one would do to
 *  package.json — so the *next* run sees the dependency already there. */
function fakeInstall(succeeds = true) {
  return async (plan: InstallPlan): Promise<boolean> => {
    installs.push(plan);
    if (!succeeds) return false;
    const file = path.join(plan.cwd, "package.json");
    const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const dev = (manifest.devDependencies ?? {}) as Record<string, string>;
    for (const [name, spec] of Object.entries(plan.packages)) dev[name] = spec;
    manifest.devDependencies = dev;
    await writeFile(file, `${JSON.stringify(manifest, undefined, 2)}\n`);
    return true;
  };
}

const logs: string[] = [];

beforeEach(() => {
  installs.length = 0;
  logs.length = 0;
});

function init(over: Partial<InitOptions> = {}): ReturnType<typeof runInit> {
  return runInit({
    project,
    install: fakeInstall(),
    log: (message) => logs.push(message),
    ...over,
  });
}

async function write(relative: string, content: string): Promise<void> {
  const file = path.join(project, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function read(relative: string): Promise<string> {
  return readFile(path.join(project, relative), "utf8");
}

async function exists(relative: string): Promise<boolean> {
  return readFile(path.join(project, relative), "utf8").then(
    () => true,
    () => false,
  );
}

/** Every file in the project, with its bytes: the thing a second run must not
 *  change. */
async function snapshot(dir = project, prefix = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, value] of await snapshot(path.join(dir, entry.name), relative)) {
        out.set(key, value);
      }
    } else {
      out.set(relative, await readFile(path.join(dir, entry.name), "utf8"));
    }
  }
  return out;
}

const NEXT_LAYOUT = `export const metadata = { title: "app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
`;

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`;

async function nextAppProject(over: Record<string, unknown> = {}): Promise<void> {
  await write(
    "package.json",
    `${JSON.stringify(
      {
        name: "demo",
        scripts: { dev: "next dev", build: "next build" },
        dependencies: { next: "15.0.0", react: "19.0.0" },
        ...over,
      },
      undefined,
      2,
    )}\n`,
  );
  await write("app/layout.tsx", NEXT_LAYOUT);
}

async function viteProject(): Promise<void> {
  await write(
    "package.json",
    `${JSON.stringify(
      {
        name: "demo",
        scripts: { dev: "vite", build: "vite build" },
        devDependencies: { vite: "^6.0.0" },
      },
      undefined,
      2,
    )}\n`,
  );
  await write("vite.config.ts", VITE_CONFIG);
}

// ── 1. the devDependency ────────────────────────────────────────────────────

describe("installing the package", () => {
  it("uses the package manager the lockfile names", async () => {
    await viteProject();
    await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const result = await init();

    expect(result.manager).toBe("pnpm");
    expect(installs[0]?.command.slice(0, 3)).toEqual(["pnpm", "add", "-D"]);
    expect(installs[0]?.command).toContain("@hulbu/fixui");
  });

  it("uses yarn for yarn.lock and npm for package-lock.json", async () => {
    await viteProject();
    await write("yarn.lock", "");
    expect((await init()).manager).toBe("yarn");
    expect(installs[0]?.command.slice(0, 3)).toEqual(["yarn", "add", "--dev"]);
  });

  it("falls back to npm when no lockfile says otherwise", async () => {
    await viteProject();
    expect((await init()).manager).toBe("npm");
    expect(installs[0]?.command.slice(0, 3)).toEqual(["npm", "install", "--save-dev"]);
  });

  it("prints the command and keeps going when the install fails", async () => {
    await viteProject();

    const result = await init({ install: fakeInstall(false) });

    expect(result.skipped.join("\n")).toMatch(/npm install --save-dev/);
    // The failure must not have cost the project the rest of the setup.
    expect(await exists(".claude/skills/fix-ui/SKILL.md")).toBe(true);
    expect(await exists(".mcp.json")).toBe(true);
    expect(await read("package.json")).toContain("fixui dev -- vite");
  });

  it("keeps the dependencies the package manager wrote, when it then edits the dev script", async () => {
    await viteProject();

    await init();

    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // The manager owns package.json from the moment it runs; writing a stale
    // copy of it back would silently undo the install.
    expect(manifest.devDependencies["@hulbu/fixui"]).toBeDefined();
    expect(manifest.devDependencies["fixui-bridge"]).toBeDefined();
    expect(manifest.devDependencies.vite).toBe("^6.0.0");
    expect(manifest.scripts.dev).toBe("fixui dev -- vite");
  });

  it("believes package.json over a non-zero exit code", async () => {
    await viteProject();
    // pnpm exits non-zero on things like ignored build scripts, having
    // installed perfectly well.
    const grumpy = fakeInstall();
    const result = await init({
      install: async (plan) => {
        await grumpy(plan);
        return false;
      },
    });

    expect(result.changed.join("\n")).toMatch(/installed @hulbu\/fixui/);
    expect(result.skipped.join("\n")).not.toMatch(/install/);
  });

  it("does not install again when the package is already a dependency", async () => {
    await viteProject();
    await init();
    installs.length = 0;

    await init();

    expect(installs).toEqual([]);
  });
});

// ── 2. the skill ────────────────────────────────────────────────────────────

describe("the skill", () => {
  it("copies the shipped skill directory into .claude/skills/fix-ui/", async () => {
    await viteProject();

    await init();

    expect(await read(".claude/skills/fix-ui/SKILL.md")).toContain("name: fix-ui");
  });

  it("ships a skill directory that init can find with no help", async () => {
    const source = await resolveSkillSource();
    expect(source).toBeDefined();
    expect(await readFile(path.join(source!, "SKILL.md"), "utf8")).toContain("name: fix-ui");
  });
});

// ── 3. .mcp.json ────────────────────────────────────────────────────────────

describe(".mcp.json", () => {
  it("creates it with the fixui server", async () => {
    await viteProject();

    await init();

    expect(JSON.parse(await read(".mcp.json"))).toEqual({
      mcpServers: { fixui: { command: "npx", args: ["fixui-bridge"] } },
    });
  });

  it("merges into an existing file, preserving the other servers", async () => {
    await viteProject();
    await write(
      ".mcp.json",
      `${JSON.stringify({ mcpServers: { other: { command: "other" } } }, undefined, 2)}\n`,
    );

    await init();

    const parsed = JSON.parse(await read(".mcp.json")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.other).toEqual({ command: "other" });
    expect(parsed.mcpServers.fixui).toEqual({ command: "npx", args: ["fixui-bridge"] });
  });

  it("leaves an existing fixui entry exactly as the developer wrote it", async () => {
    await viteProject();
    const mine = `${JSON.stringify(
      { mcpServers: { fixui: { command: "node", args: ["/somewhere/cli.js"] } } },
      undefined,
      2,
    )}\n`;
    await write(".mcp.json", mine);

    await init();

    expect(await read(".mcp.json")).toBe(mine);
  });

  it("skips rather than destroys a .mcp.json it cannot parse", async () => {
    await viteProject();
    await write(".mcp.json", "{ not json");

    const result = await init();

    expect(await read(".mcp.json")).toBe("{ not json");
    expect(result.skipped.join("\n")).toMatch(/\.mcp\.json/);
  });
});

// ── 4. CLAUDE.md ────────────────────────────────────────────────────────────

describe("CLAUDE.md", () => {
  it("creates it with the fix-ui line", async () => {
    await viteProject();

    await init();

    expect(await read("CLAUDE.md")).toMatch(/fix ui/);
    expect(await read("CLAUDE.md")).toContain(".fix-ui.jsonl");
  });

  it("appends to an existing file without touching what is there", async () => {
    await viteProject();
    await write("CLAUDE.md", "# House rules\n\nUse tabs.\n");

    await init();

    const content = await read("CLAUDE.md");
    expect(content.startsWith("# House rules\n\nUse tabs.\n")).toBe(true);
    expect(content).toContain(".fix-ui.jsonl");
  });

  it("never adds the line twice", async () => {
    await viteProject();
    await init();
    await init();

    const content = await read("CLAUDE.md");
    expect(content.split(".fix-ui.jsonl").length - 1).toBe(1);
  });
});

// ── 5. .gitignore ───────────────────────────────────────────────────────────

describe(".gitignore", () => {
  it("adds the three fix-ui files", async () => {
    await viteProject();

    await init();

    const lines = (await read(".gitignore")).split("\n");
    expect(lines).toContain(".fix-ui.json");
    expect(lines).toContain(".fix-ui.jsonl");
    expect(lines).toContain(".fix-ui.reviews.jsonl");
  });

  it("keeps existing rules and only adds what is missing", async () => {
    await viteProject();
    await write(".gitignore", "node_modules\n.fix-ui.jsonl\n");

    await init();

    const content = await read(".gitignore");
    expect(content.startsWith("node_modules\n.fix-ui.jsonl\n")).toBe(true);
    expect(content.split(".fix-ui.jsonl\n").length - 1).toBe(1);
    expect(content).toContain(".fix-ui.reviews.jsonl");
  });
});

// ── 6. the two edits ────────────────────────────────────────────────────────

describe("Next (app router)", () => {
  it("wraps the dev script, renders the adapter and transpiles the embed", async () => {
    await nextAppProject();

    const result = await init();

    expect(result.stack).toBe("next-app");

    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.dev).toBe("fixui dev -- next dev");
    expect(manifest.scripts.build).toBe("next build");

    const layout = await read("app/layout.tsx");
    expect(layout).toContain('import { FixUiScript } from "@hulbu/fixui/next";');
    expect(layout).toMatch(/<FixUiScript \/>\s*<\/body>/);

    // The embed ships raw TypeScript: without this the integration is silent.
    const config = await read("next.config.mjs");
    expect(config).toContain("@hulbu/fixui-core");
    expect(config).toContain("transpilePackages");
  });

  it("finds a src/app layout too", async () => {
    await nextAppProject();
    await rm(path.join(project, "app"), { recursive: true });
    await write("src/app/layout.tsx", NEXT_LAYOUT);

    const result = await init();

    expect(result.stack).toBe("next-app");
    expect(await read("src/app/layout.tsx")).toContain("FixUiScript");
  });

  it("merges transpilePackages into an existing next.config", async () => {
    await nextAppProject();
    await write(
      "next.config.mjs",
      `const nextConfig = {\n  reactStrictMode: true,\n  transpilePackages: ["ui-kit"],\n};\n\nexport default nextConfig;\n`,
    );

    await init();

    const config = await read("next.config.mjs");
    expect(config).toContain("reactStrictMode: true");
    expect(config).toMatch(/transpilePackages: \[[^\]]*"ui-kit"[^\]]*\]/);
    expect(config).toMatch(/transpilePackages: \[[^\]]*"@hulbu\/fixui"[^\]]*\]/);
  });

  it("adds transpilePackages to a config that has none", async () => {
    await nextAppProject();
    await write(
      "next.config.js",
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  reactStrictMode: true,\n};\n\nmodule.exports = nextConfig;\n`,
    );

    await init();

    const config = await read("next.config.js");
    expect(config).toContain("reactStrictMode: true");
    expect(config).toContain('transpilePackages: ["@hulbu/fixui", "@hulbu/fixui-core"]');
  });

  it("skips a layout it cannot read confidently and says what to add", async () => {
    await nextAppProject();
    await write("app/layout.tsx", "export default function L() { return null; }\n");

    const result = await init();

    expect(await read("app/layout.tsx")).toBe("export default function L() { return null; }\n");
    expect(result.skipped.join("\n")).toMatch(/FixUiScript/);
    expect(result.skipped.join("\n")).toMatch(/layout\.tsx/);
  });

  it("does not wrap a dev script that is already wrapped", async () => {
    await nextAppProject({ scripts: { dev: "fixui dev -- next dev" } });

    await init();

    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.dev).toBe("fixui dev -- next dev");
  });
});

describe("Next (pages router)", () => {
  it("wraps the dev script but leaves the injection to the agent", async () => {
    await nextAppProject();
    await rm(path.join(project, "app"), { recursive: true });
    await write("pages/index.tsx", "export default function Home() { return null; }\n");

    const result = await init();

    expect(result.stack).toBe("next-pages");
    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.dev).toBe("fixui dev -- next dev");
    expect(await read("pages/index.tsx")).toBe(
      "export default function Home() { return null; }\n",
    );
    expect(logs.join("\n")).toMatch(/_app/);
  });
});

describe("Vite", () => {
  it("wraps the dev script and adds the plugin", async () => {
    await viteProject();

    const result = await init();

    expect(result.stack).toBe("vite");
    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.dev).toBe("fixui dev -- vite");

    const config = await read("vite.config.ts");
    expect(config).toContain('import { fixui } from "@hulbu/fixui/vite";');
    expect(config).toContain("react()");
    expect(config).toMatch(/plugins: \[[\s\S]*fixui\(\)/);
  });

  it("skips a config with two plugins arrays rather than pick one", async () => {
    await viteProject();
    const ambiguous = `export default {\n  css: { postcss: { plugins: [] } },\n  plugins: [],\n};\n`;
    await write("vite.config.ts", ambiguous);

    const result = await init();

    expect(await read("vite.config.ts")).toBe(ambiguous);
    expect(result.skipped.join("\n")).toMatch(/plugins/);
  });

  it("skips a config with no plugins array and says what to add", async () => {
    await viteProject();
    await write("vite.config.ts", `export default { server: { port: 3000 } };\n`);

    const result = await init();

    expect(await read("vite.config.ts")).toBe(`export default { server: { port: 3000 } };\n`);
    expect(result.skipped.join("\n")).toMatch(/fixui\(\)/);
  });
});

describe("an unrecognised project", () => {
  it("makes no source edits and prints the adapter table", async () => {
    await write(
      "package.json",
      `${JSON.stringify({ name: "demo", scripts: { dev: "node server.js" } }, undefined, 2)}\n`,
    );

    const result = await init();

    expect(result.stack).toBe("unknown");
    expect(logs.join("\n")).toMatch(/@hulbu\/fixui\/next/);
    expect(logs.join("\n")).toMatch(/@hulbu\/fixui\/vite/);
    // The lifetime wrapper is right whatever the framework is.
    const manifest = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.dev).toBe("fixui dev -- node server.js");
  });
});

describe("a package.json it cannot parse", () => {
  it("skips everything that depends on it and still sets up the rest", async () => {
    await write("package.json", "{ oops");

    const result = await init();

    expect(await read("package.json")).toBe("{ oops");
    expect(result.stack).toBe("unknown");
    expect(result.skipped.join("\n")).toMatch(/package\.json/);
    expect(installs).toEqual([]);
    expect(await exists(".claude/skills/fix-ui/SKILL.md")).toBe(true);
    expect(await exists(".mcp.json")).toBe(true);
    expect(await exists("CLAUDE.md")).toBe(true);
    expect(await exists(".gitignore")).toBe(true);
  });
});

// ── idempotence ─────────────────────────────────────────────────────────────

describe("running twice", () => {
  it("changes nothing the second time (Next)", async () => {
    await nextAppProject();
    await init();
    const before = await snapshot();

    const result = await init();

    expect(await snapshot()).toEqual(before);
    expect(result.changed).toEqual([]);
  });

  it("changes nothing the second time (Vite)", async () => {
    await viteProject();
    await write(".gitignore", "node_modules\n");
    await write("CLAUDE.md", "# rules\n");
    await init();
    const before = await snapshot();

    const result = await init();

    expect(await snapshot()).toEqual(before);
    expect(result.changed).toEqual([]);
  });
});

// ── local mode ──────────────────────────────────────────────────────────────

describe("--local", () => {
  it("points the MCP server at the checkout and installs from it", async () => {
    await viteProject();
    await write("pnpm-lock.yaml", "");
    const local = "/abs/path/to/fix-ui";

    await init({ local, skillSource: await resolveSkillSource() });

    expect(JSON.parse(await read(".mcp.json"))).toEqual({
      mcpServers: {
        fixui: { command: "node", args: [`${local}/packages/bridge/dist/cli.js`] },
      },
    });
    expect(installs[0]?.packages["@hulbu/fixui"]).toBe(`link:${local}/packages/embed`);
  });

  it("uses file: for npm", async () => {
    await viteProject();
    const local = "/abs/path/to/fix-ui";

    await init({ local, skillSource: await resolveSkillSource() });

    expect(installs[0]?.packages["@hulbu/fixui"]).toBe(`file:${local}/packages/embed`);
  });
});
