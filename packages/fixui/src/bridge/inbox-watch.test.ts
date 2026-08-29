/**
 * The proxy's inbox watch — the process-local half of `feedback/updated`
 * (docs/agent-integration.md).
 *
 * The interesting case is not the happy one: a directory watch is a resource
 * the OS can refuse (macOS answers `EMFILE` once FSEvents runs out of streams,
 * Linux does the same at `max_user_watches`, network mounts have none at all),
 * and it can refuse either by throwing or by handing over a watcher that then
 * errors. Both used to end with the notification silently never arriving again.
 * So both are exercised here on every platform, not just on the one that
 * happens to be short of watches today.
 */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { watchInbox } from "./inbox-watch.js";
import { INBOX_FILE } from "./storage.js";

const tempDirs: string[] = [];
const stoppers: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stoppers.splice(0)) stop();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fixui-watch-"));
  tempDirs.push(dir);
  return dir;
}

/** Start watching `project` and collect the hints it produces. */
function hints(project: string, options: Parameters<typeof watchInbox>[1] = {}): string[] {
  const seen: string[] = [];
  stoppers.push(watchInbox(project, { pollMs: 25, ...options })((named) => seen.push(named)));
  return seen;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A watch the OS refused the way macOS does: handed over, then errored. */
function refusesAsynchronously(): Parameters<typeof watchInbox>[1] {
  return {
    startWatch: ((): any => {
      const watcher = new EventEmitter() as EventEmitter & { close(): void };
      watcher.close = () => undefined;
      setTimeout(() => watcher.emit("error", Object.assign(new Error("EMFILE"), { code: "EMFILE" })), 0);
      return watcher;
    }) as never,
  };
}

/** A watch the OS refused the way a missing directory or a mount with no watch
 *  support does: `watch()` itself throws. */
function refusesImmediately(): Parameters<typeof watchInbox>[1] {
  return {
    startWatch: (() => {
      throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
    }) as never,
  };
}

it("hints when the inbox is created, appended to and rewritten", async () => {
  const dir = await tempProject();
  const file = path.join(dir, INBOX_FILE);
  const seen = hints(dir);

  await writeFile(file, '{"id":"a"}\n');
  await waitFor(() => seen.length >= 1, "the create hint");
  expect(seen[0]).toBe(dir); // the hint names the project, which is all it carries

  await writeFile(file, '{"id":"a"}\n{"id":"b"}\n');
  await waitFor(() => seen.length >= 2, "the append hint");

  await writeFile(file, ""); // what `resolve_feedback` leaves behind
  await waitFor(() => seen.length >= 3, "the rewrite hint");
});

it("falls back to polling when the OS hands over a watch and then refuses it", async () => {
  const dir = await tempProject();
  const seen = hints(dir, refusesAsynchronously());

  // Nothing has happened yet, and a refusal is not itself a change.
  await new Promise((done) => setTimeout(done, 150));
  expect(seen).toEqual([]);

  await writeFile(path.join(dir, INBOX_FILE), '{"id":"a"}\n');
  await waitFor(() => seen.length >= 1, "the polled create hint");
  expect(seen[0]).toBe(dir);

  await writeFile(path.join(dir, INBOX_FILE), '{"id":"a"}\n{"id":"b"}\n');
  await waitFor(() => seen.length >= 2, "the polled append hint");
});

it("falls back to polling when the watch cannot be started at all", async () => {
  const dir = await tempProject();
  const seen = hints(dir, refusesImmediately());

  await writeFile(path.join(dir, INBOX_FILE), '{"id":"a"}\n');
  await waitFor(() => seen.length >= 1, "the polled hint");
  expect(seen[0]).toBe(dir);
});

it("polls a project directory that does not exist yet, without throwing", async () => {
  // The real refusal a missing directory produces, with no injection at all:
  // `watch()` throws ENOENT on every platform, and the poll has to survive a
  // file whose parent is not there — then hint once it is.
  const parent = await tempProject();
  const project = path.join(parent, "not-yet");
  const seen = hints(project);

  await new Promise((done) => setTimeout(done, 150));
  expect(seen).toEqual([]);

  await mkdir(project);
  await writeFile(path.join(project, INBOX_FILE), '{"id":"a"}\n');
  await waitFor(() => seen.length >= 1, "the hint for a directory that appeared later");
  expect(seen[0]).toBe(project);
});

it("stops hinting once the watch is stopped, by either mechanism", async () => {
  for (const options of [{}, refusesAsynchronously()]) {
    const dir = await tempProject();
    const seen: string[] = [];
    const stop = watchInbox(dir, { pollMs: 25, ...options })((named) => seen.push(named));

    await writeFile(path.join(dir, INBOX_FILE), '{"id":"a"}\n');
    await waitFor(() => seen.length >= 1, "the first hint");
    stop();

    const after = seen.length;
    await writeFile(path.join(dir, INBOX_FILE), '{"id":"a"}\n{"id":"b"}\n');
    await new Promise((done) => setTimeout(done, 200));
    expect(seen.length).toBe(after);
  }
});
