/**
 * `feedback/updated` for the proxy (docs/agent-integration.md). The inbox is a
 * file in *this* process's project, so the notification the daemon sends from
 * its own broker is a file watch here — the same promise to the harness, made
 * by the process the harness is actually connected to.
 *
 * The directory is watched rather than the file: the inbox does not exist until
 * the first note, and a rewrite (`resolve_feedback`) replaces it.
 *
 * **The OS is allowed to refuse.** A directory watch is FSEvents on macOS and
 * inotify on Linux, and both run out: `FSEventStreamStart` fails (as `EMFILE`)
 * once a machine has enough streams open, inotify does the same at
 * `max_user_watches`, and some network and container mounts have no watches at
 * all. That refusal used to be swallowed here — the watch was dropped and the
 * documented notification then silently never arrived again for the life of the
 * session. A refusal now falls back to polling the inbox's stat: coarser, but
 * it is the difference between a late hint and no hint, and only the machines
 * that need it pay for it.
 *
 * The refusal can arrive either way — `watch()` throws, or it hands back a
 * watcher that errors a tick later — so the poll's baseline is taken up front,
 * when the subscription starts. Reading it when the fallback begins would miss
 * anything that landed in between.
 */
import { statSync, watch } from "node:fs";
import path from "node:path";
import type { InboxChanges } from "./mcp.js";
import { INBOX_FILE } from "./storage.js";

/** How long several filesystem events for one note are gathered into one hint. */
const COALESCE_MS = 50;

/** How often the fallback re-stats the inbox. Reached only when the OS refused
 *  a real watch, so it is a floor on that machine's hint latency, not a poll
 *  every machine pays: fast enough to feel immediate, cheap enough to ignore. */
export const POLL_MS = 500;

/** How a native directory watch is started. Injectable so a test can reproduce
 *  a platform's refusal on a platform that does not refuse. */
export type StartWatch = typeof watch;

export interface InboxWatchOptions {
  startWatch?: StartWatch;
  pollMs?: number;
}

export function watchInbox(project: string, options: InboxWatchOptions = {}): InboxChanges {
  const startWatch = options.startWatch ?? watch;
  const pollMs = options.pollMs ?? POLL_MS;
  const file = path.join(project, INBOX_FILE);

  /** The inbox's state as one comparable string; an absent inbox is "". Size
   *  as well as mtime: a rewrite can land inside one mtime tick. */
  const snapshot = (): string => {
    try {
      const stats = statSync(file);
      return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
    } catch {
      return "";
    }
  };

  return (listener) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const announce = (): void => {
      // Coalesced: one note can be several filesystem events, and the listener
      // is a "look again" hint, not a diff.
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = undefined;
        listener(project);
      }, COALESCE_MS);
      timer.unref(); // a pending hint must never hold the process open
    };

    let watcher: ReturnType<StartWatch> | undefined;
    let poller: NodeJS.Timeout | undefined;
    let seen = snapshot(); // before any watch, so the fallback misses nothing

    const pollInstead = (): void => {
      if (stopped || poller !== undefined) return;
      poller = setInterval(() => {
        const now = snapshot();
        if (now === seen) return;
        seen = now;
        announce();
      }, pollMs);
      poller.unref(); // like the hint itself, never a reason to stay alive
    };

    try {
      watcher = startWatch(project, (_event, filename) => {
        if (filename === null || filename === INBOX_FILE) announce();
      });
      // The other shape of refusal: handed over, then errored — which is how
      // macOS reports an FSEvents stream it could not start.
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
        pollInstead();
      });
    } catch {
      watcher = undefined;
      pollInstead();
    }

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (poller) clearInterval(poller);
      poller = undefined;
      watcher?.close();
      watcher = undefined;
    };
  };
}
