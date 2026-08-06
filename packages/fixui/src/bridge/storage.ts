/**
 * The inbox on disk. One JSON object per line in `<project>/.fix-ui.jsonl`
 * (docs/capture-format.md) — no database, the file *is* the queue: resolved
 * entries are removed, no tombstones. Review sessions get their own
 * append-only record next to it.
 *
 * This module owns every filesystem touch in the bridge; server.ts only calls
 * these functions.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const INBOX_FILE = ".fix-ui.jsonl";
export const REVIEWS_FILE = ".fix-ui.reviews.jsonl";

export type JsonRecord = Record<string, unknown>;

/** A failed read/write of an inbox file, carrying the path the bridge tried
 *  (docs/design.md "Error handling": the adapter shows it verbatim). */
export class InboxError extends Error {
  readonly path: string;

  constructor(action: "read" | "write", filePath: string, cause: unknown) {
    super(`cannot ${action} ${filePath}: ${describe(cause)}`, { cause });
    this.name = "InboxError";
    this.path = filePath;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isMissingFile(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function inboxPath(projectDir: string): string {
  return path.join(projectDir, INBOX_FILE);
}

export function reviewsPath(projectDir: string): string {
  return path.join(projectDir, REVIEWS_FILE);
}

/**
 * Wire-level project routing (docs/capture-format.md): an absolute path to an
 * existing directory wins, an absent one falls back to the daemon's project,
 * anything else is a client error (`null` → the caller answers 400).
 */
export function resolveProject(requested: unknown, fallback: string): string | null {
  if (requested === undefined || requested === null || requested === "") return fallback;
  if (typeof requested !== "string" || !path.isAbsolute(requested)) return null;
  try {
    return statSync(requested).isDirectory() ? path.resolve(requested) : null;
  } catch {
    return null;
  }
}

/**
 * One operation at a time per file. `removeEntry` is a read-modify-write, so
 * without this two parallel deletes both read the same inbox, each drops its
 * own id and the later write restores the other's entry — and an append landing
 * mid-rewrite is truncated away. Reads queue too, so nobody sees a torn file.
 * Queued work must never call back into these functions for the same file.
 */
const chains = new Map<string, Promise<void>>();

function serialize<T>(file: string, work: () => Promise<T>): Promise<T> {
  const result = (chains.get(file) ?? Promise.resolve()).then(work);
  const settled = result.then(
    () => undefined,
    () => undefined, // a failed operation must not wedge the file's queue
  );
  chains.set(file, settled);
  void settled.then(() => {
    if (chains.get(file) === settled) chains.delete(file); // idle files leave no trace
  });
  return result;
}

function appendLine(file: string, record: JsonRecord): Promise<void> {
  return serialize(file, async () => {
    try {
      await appendFile(file, `${JSON.stringify(record)}\n`);
    } catch (cause) {
      throw new InboxError("write", file, cause);
    }
  });
}

async function readLines(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return []; // an inbox that was never written is empty, not broken
    throw new InboxError("read", file, cause);
  }
  return raw.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Append one entry, returning exactly what went to disk. Unknown fields travel
 * verbatim (forward compatibility); the wire-only `project` field is stripped —
 * the inbox's location already encodes it. A missing `id` gets a uuid, and
 * nothing else is stamped (prototype parity).
 */
export async function appendEntry(projectDir: string, entry: JsonRecord): Promise<JsonRecord> {
  const stored: JsonRecord = { id: randomUUID(), ...entry }; // the entry's own id wins
  delete stored.project;
  await appendLine(inboxPath(projectDir), stored);
  return stored;
}

export function listEntries(projectDir: string): Promise<JsonRecord[]> {
  const file = inboxPath(projectDir);
  return serialize(file, () => readEntries(file));
}

async function readEntries(file: string): Promise<JsonRecord[]> {
  const entries: JsonRecord[] = [];
  for (const line of await readLines(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a half-written or hand-edited line must not take the inbox down
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      entries.push(parsed as JsonRecord);
    }
  }
  return entries;
}

/** Rewrite the inbox without `id`. Reports whether anything was removed; an
 *  unknown id leaves the file untouched (and never creates one). */
export function removeEntry(projectDir: string, id: string): Promise<boolean> {
  const file = inboxPath(projectDir);
  // Read and rewrite as one turn: nothing else touches this file in between.
  return serialize(file, async () => {
    const entries = await readEntries(file);
    const remaining = entries.filter((entry) => entry.id !== id);
    if (remaining.length === entries.length) return false;

    const body = remaining.map((entry) => JSON.stringify(entry)).join("\n");
    try {
      await writeFile(file, remaining.length > 0 ? `${body}\n` : "");
    } catch (cause) {
      throw new InboxError("write", file, cause);
    }
    return true;
  });
}

/** Append-only audit trail of review sessions (docs/capture-format.md). */
export async function appendReview(projectDir: string, record: JsonRecord): Promise<void> {
  await appendLine(reviewsPath(projectDir), record);
}
