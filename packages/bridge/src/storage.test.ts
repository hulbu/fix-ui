import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEntry,
  appendReview,
  InboxError,
  inboxPath,
  listEntries,
  removeEntry,
  resolveProject,
  reviewsPath,
} from "./storage.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "fixui-storage-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, id: "e1", note: "make it bigger", selector: "#hero button", ...over };
}

async function lines(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean);
}

describe("appendEntry", () => {
  it("appends one JSON line per entry to <project>/.fix-ui.jsonl", async () => {
    await appendEntry(projectDir, entry({ id: "a" }));
    await appendEntry(projectDir, entry({ id: "b" }));

    const raw = await readFile(inboxPath(projectDir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).id)).toEqual(["a", "b"]);
  });

  it("strips the wire-only project field and preserves unknown fields verbatim", async () => {
    const stored = await appendEntry(
      projectDir,
      entry({ project: projectDir, futureField: { nested: [1, 2] }, elementText: "Continue" }),
    );

    expect(stored.project).toBeUndefined();
    expect(stored.futureField).toEqual({ nested: [1, 2] });
    expect(JSON.parse((await lines(inboxPath(projectDir)))[0]!)).toEqual({
      v: 1,
      id: "e1",
      note: "make it bigger",
      selector: "#hero button",
      futureField: { nested: [1, 2] },
      elementText: "Continue",
    });
  });

  it("generates a uuid when the entry lacks an id and keeps a provided id", async () => {
    const generated = await appendEntry(projectDir, { note: "n", selector: "s" });
    expect(generated.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

    const kept = await appendEntry(projectDir, entry({ id: "given" }));
    expect(kept.id).toBe("given");
  });

  it("throws an InboxError naming the attempted path when the inbox is unwritable", async () => {
    // A directory where the inbox file belongs: unwritable on every platform.
    await mkdir(inboxPath(projectDir));

    await expect(appendEntry(projectDir, entry())).rejects.toMatchObject({
      name: "InboxError",
      path: inboxPath(projectDir),
    });
    await expect(appendEntry(projectDir, entry())).rejects.toThrow(inboxPath(projectDir));
  });
});

describe("listEntries", () => {
  it("returns an empty list when the inbox does not exist", async () => {
    expect(await listEntries(projectDir)).toEqual([]);
  });

  it("parses each line and skips malformed ones", async () => {
    await writeFile(
      inboxPath(projectDir),
      `${JSON.stringify(entry({ id: "a" }))}\nnot json\n${JSON.stringify(entry({ id: "b" }))}\n`,
    );

    expect((await listEntries(projectDir)).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("throws an InboxError naming the path when the inbox cannot be read", async () => {
    await mkdir(inboxPath(projectDir));

    await expect(listEntries(projectDir)).rejects.toThrow(inboxPath(projectDir));
  });
});

describe("removeEntry", () => {
  it("rewrites the inbox without the removed id, keeping a trailing newline", async () => {
    await appendEntry(projectDir, entry({ id: "a" }));
    await appendEntry(projectDir, entry({ id: "b" }));

    expect(await removeEntry(projectDir, "a")).toBe(true);

    const raw = await readFile(inboxPath(projectDir), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line).id)).toEqual(["b"]);
  });

  it("leaves an empty file (no trailing newline) when the last entry goes", async () => {
    await appendEntry(projectDir, entry({ id: "only" }));

    expect(await removeEntry(projectDir, "only")).toBe(true);
    expect(await readFile(inboxPath(projectDir), "utf8")).toBe("");
  });

  it("reports false for an unknown id without rewriting the inbox", async () => {
    await appendEntry(projectDir, entry({ id: "a" }));
    const before = await readFile(inboxPath(projectDir), "utf8");

    expect(await removeEntry(projectDir, "missing")).toBe(false);
    expect(await readFile(inboxPath(projectDir), "utf8")).toBe(before);
  });
});

describe("appendReview", () => {
  it("appends session records to <project>/.fix-ui.reviews.jsonl", async () => {
    await appendReview(projectDir, { id: "r1", verdict: "approved", entryIds: ["a"] });
    await appendReview(projectDir, { id: "r2", verdict: "changes", entryIds: [] });

    expect((await lines(reviewsPath(projectDir))).map((line) => JSON.parse(line).id)).toEqual([
      "r1",
      "r2",
    ]);
    // Reviews live beside the inbox, never inside it.
    expect(await listEntries(projectDir)).toEqual([]);
  });
});

describe("resolveProject", () => {
  it("falls back when no project is requested", () => {
    expect(resolveProject(undefined, projectDir)).toBe(projectDir);
    expect(resolveProject(null, projectDir)).toBe(projectDir);
    expect(resolveProject("", projectDir)).toBe(projectDir);
  });

  it("accepts an absolute path to an existing directory", () => {
    expect(resolveProject(projectDir, "/nope")).toBe(projectDir);
  });

  it("rejects relative paths, missing directories, files and non-strings", async () => {
    const file = path.join(projectDir, "file.txt");
    await writeFile(file, "x");

    expect(resolveProject("packages/bridge", projectDir)).toBeNull();
    expect(resolveProject(path.join(projectDir, "missing"), projectDir)).toBeNull();
    expect(resolveProject(file, projectDir)).toBeNull();
    expect(resolveProject(42, projectDir)).toBeNull();
  });
});

describe("InboxError", () => {
  it("carries the attempted path in both the message and the property", () => {
    const error = new InboxError("write", "/tmp/x/.fix-ui.jsonl", new Error("EACCES"));

    expect(error.path).toBe("/tmp/x/.fix-ui.jsonl");
    expect(error.message).toContain("/tmp/x/.fix-ui.jsonl");
    expect(error.message).toContain("EACCES");
  });
});
