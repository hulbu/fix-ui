import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DISCOVERY_FILE, findDiscovery, parseDiscovery } from "./find-discovery.js";

/**
 * Real directories with real marker files. The whole point of the walk is which
 * files it finds where, so a mocked filesystem would only test the mock.
 */
let root: string;

const discovery = { v: 1, port: 49876, token: "tok-root", pid: 4242 };
const inner = { v: 1, port: 51000, token: "tok-inner", pid: 4343 };

async function dirs(...segments: string[][]): Promise<void> {
  for (const segment of segments) await mkdir(path.join(root, ...segment), { recursive: true });
}

function at(...segments: string[]): string {
  return path.join(root, ...segments);
}

async function writeDiscovery(dir: string, contents: unknown = discovery): Promise<void> {
  await writeFile(path.join(dir, DISCOVERY_FILE), `${JSON.stringify(contents)}\n`, "utf8");
}

async function writePackage(dir: string): Promise<void> {
  await writeFile(path.join(dir, "package.json"), '{"name":"x"}', "utf8");
}

/** A `.git` directory, as a plain clone has. */
async function gitDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, ".git"), { recursive: true });
}

/** A `.git` *file*, as a worktree or submodule has. */
async function gitFile(dir: string): Promise<void> {
  await writeFile(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n", "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fixui-find-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findDiscovery", () => {
  it("finds the workspace-root bridge from inside a monorepo package", async () => {
    // The motivating layout: `fixui dev` at the repo root, Next's cwd in website/.
    await dirs(["website"]);
    await gitDir(root);
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - website\n", "utf8");
    await writePackage(root);
    await writeDiscovery(root);
    await writePackage(at("website"));

    await expect(findDiscovery(at("website"))).resolves.toEqual(discovery);
  });

  it("climbs past several nested package.json files to the repo root", async () => {
    await dirs(["apps", "web", "src"]);
    await gitDir(root);
    await writeDiscovery(root);
    await writePackage(at("apps"));
    await writePackage(at("apps", "web"));

    await expect(findDiscovery(at("apps", "web", "src"))).resolves.toEqual(discovery);
  });

  it("still finds a discovery file beside a standalone app's package.json", async () => {
    await writePackage(root);
    await writeDiscovery(root);

    await expect(findDiscovery(root)).resolves.toEqual(discovery);
  });

  it("crosses no repository boundary: a sibling repo's bridge stays invisible", async () => {
    // outer/ is the stranger; inner/ is a nested repo (submodule) whose walk
    // must stop at its own .git rather than climb into outer/.
    await dirs(["inner", "app"]);
    await gitDir(root);
    await writeDiscovery(root);
    await gitDir(at("inner"));
    await writePackage(at("inner", "app"));

    await expect(findDiscovery(at("inner", "app"))).resolves.toBeUndefined();
  });

  it("treats a .git file (worktree, submodule) as the repository root", async () => {
    await dirs(["website"]);
    await gitFile(root);
    await writeDiscovery(root);
    await writePackage(at("website"));

    await expect(findDiscovery(at("website"))).resolves.toEqual(discovery);
  });

  it("a .git file also stops the walk, exactly as a .git directory does", async () => {
    await dirs(["inner", "app"]);
    await gitDir(root);
    await writeDiscovery(root);
    await gitFile(at("inner"));

    await expect(findDiscovery(at("inner", "app"))).resolves.toBeUndefined();
  });

  it("prefers the nearest discovery file when a package publishes its own", async () => {
    await dirs(["website"]);
    await gitDir(root);
    await writeDiscovery(root);
    await writePackage(at("website"));
    await writeDiscovery(at("website"), inner);

    await expect(findDiscovery(at("website"))).resolves.toEqual(inner);
  });

  it("prefers the nearest discovery file even between two package levels", async () => {
    await dirs(["apps", "web"]);
    await gitDir(root);
    await writeDiscovery(root);
    await writeDiscovery(at("apps"), inner);
    await writePackage(at("apps", "web"));

    await expect(findDiscovery(at("apps", "web"))).resolves.toEqual(inner);
  });

  it("falls back to stopping at the first package.json when there is no repository", async () => {
    // A tarball or a container image with the .git stripped: no repository
    // boundary exists, so the old, narrower rule is what keeps a stranger's
    // discovery file out.
    await dirs(["website"]);
    await writeDiscovery(root);
    await writePackage(at("website"));

    await expect(findDiscovery(at("website"))).resolves.toBeUndefined();
  });

  it("with no repository and no package.json, still finds a discovery file above", async () => {
    await dirs(["a", "b"]);
    await writeDiscovery(root);

    await expect(findDiscovery(at("a", "b"))).resolves.toEqual(discovery);
  });

  it("finds nothing, and does not throw, when there is nothing to find", async () => {
    await dirs(["website"]);
    await gitDir(root);
    await writePackage(at("website"));

    await expect(findDiscovery(at("website"))).resolves.toBeUndefined();
  });

  it("treats a malformed discovery file at the repo root as no bridge", async () => {
    await dirs(["website"]);
    await gitDir(root);
    await writeFile(path.join(root, DISCOVERY_FILE), "not json", "utf8");
    await writePackage(at("website"));

    await expect(findDiscovery(at("website"))).resolves.toBeUndefined();
  });

  it("skips a malformed nearer file and takes the readable one within the repo", async () => {
    await dirs(["website"]);
    await gitDir(root);
    await writeDiscovery(root);
    await writePackage(at("website"));
    await writeFile(path.join(at("website"), DISCOVERY_FILE), "{", "utf8");

    await expect(findDiscovery(at("website"))).resolves.toEqual(discovery);
  });

  it("does not throw on a path that does not exist", async () => {
    await expect(findDiscovery(at("no", "such", "place"))).resolves.toBeUndefined();
  });
});

describe("parseDiscovery", () => {
  it("accepts a well-formed record and rejects the ways it can go wrong", () => {
    expect(parseDiscovery(JSON.stringify(discovery))).toEqual(discovery);
    expect(parseDiscovery(JSON.stringify({ ...discovery, v: 2 }))).toBeUndefined();
    expect(parseDiscovery(JSON.stringify({ ...discovery, port: 0 }))).toBeUndefined();
    expect(parseDiscovery(JSON.stringify({ ...discovery, port: 70000 }))).toBeUndefined();
    expect(parseDiscovery(JSON.stringify({ ...discovery, token: " " }))).toBeUndefined();
    expect(parseDiscovery(JSON.stringify({ ...discovery, pid: -1 }))).toBeUndefined();
    expect(parseDiscovery("[]")).toBeUndefined();
    expect(parseDiscovery("nonsense")).toBeUndefined();
  });
});
