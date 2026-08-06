import { validateEntry, type FeedbackEntry } from "./entry.js";

/**
 * Talks to the bridge — or to any app-provided endpoint with the same shape.
 * Everything it touches is injectable, because core does no ambient IO.
 *
 * Error handling (docs/design.md): a failed create is queued in memory and in
 * storage, retried with exponential backoff; after MAX_ATTEMPTS failed flushes
 * entries go to the clipboard as a last resort and leave the queue — everything
 * that expires in the same round travels as ONE payload, JSONL so it can be
 * pasted straight into a `.fix-ui.jsonl` inbox. With no clipboard configured
 * there is no last resort, so it keeps retrying instead of dropping anything.
 */
const QUEUE_KEY = "fixui.queue.v1";
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 5;
const JSON_HEADERS = { "content-type": "application/json" };

export interface TransportOptions {
  /** Absolute or path, e.g. "http://127.0.0.1:3499/entries" or "/api/ui-feedback". */
  endpoint: string;
  /** Stamped onto outgoing entries when set (wire-only: the bridge routes on it). */
  project?: string;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  clipboard?: (text: string) => Promise<void>;
  onQueueChange?: (pending: number) => void;
}

export interface Transport {
  /**
   * Malformed entries are rejected outright: `{ok:false,queued:false}`, nothing
   * sent. `error` is present only when the endpoint answered and said why — the
   * caller shows it verbatim rather than guessing "bridge unreachable".
   */
  create(entry: FeedbackEntry): Promise<{ ok: boolean; queued: boolean; error?: string }>;
  list(): Promise<FeedbackEntry[]>;
  /** Body-style DELETE {id} — works against the bridge AND prototype-style app routes. */
  remove(id: string): Promise<boolean>;
  flush(): Promise<void>;
  destroy(): void;
}

interface QueuedEntry {
  entry: FeedbackEntry;
  attempts: number;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined; // storage can throw outright in sandboxed frames
  }
}

export function createTransport(opts: TransportOptions): Transport {
  const storage = opts.storage ?? defaultStorage();

  let queue: QueuedEntry[] = restore();
  let failedRounds = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | null = null;
  let notified = 0;
  let destroyed = false;

  function request(init: RequestInit, url: string = opts.endpoint): Promise<Response> {
    const impl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") return Promise.reject(new Error("no fetch implementation"));
    return impl(url, init);
  }

  /** Reads must name the same project the writes do, or the panel lists (and
   *  deletes from) the bridge's own cwd while entries land somewhere else. */
  function listUrl(): string {
    if (!opts.project) return opts.endpoint;
    const separator = opts.endpoint.includes("?") ? "&" : "?";
    return `${opts.endpoint}${separator}project=${encodeURIComponent(opts.project)}`;
  }

  function restore(): QueuedEntry[] {
    let raw: string | null = null;
    try {
      raw = storage?.getItem(QUEUE_KEY) ?? null;
    } catch {
      return [];
    }
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const restored: QueuedEntry[] = [];
    for (const item of parsed) {
      if (!validateEntry(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      restored.push({ entry: item, attempts: 0 });
    }
    return restored;
  }

  function persist(): void {
    if (!storage) return;
    try {
      if (queue.length === 0) storage.removeItem(QUEUE_KEY);
      else storage.setItem(QUEUE_KEY, JSON.stringify(queue.map((item) => item.entry)));
    } catch {
      // Storage full or unavailable — the in-memory queue still works.
    }
  }

  function notify(): void {
    if (queue.length === notified) return;
    notified = queue.length;
    opts.onQueueChange?.(notified);
  }

  function scheduleRetry(): void {
    if (destroyed || timer !== undefined || queue.length === 0) return;
    const delay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, failedRounds - 1), MAX_DELAY_MS);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  }

  /**
   * `{ok:false}` with no `error` is "the bridge never answered"; with one, the
   * bridge answered and that string is its own words (docs/design.md "Error
   * handling": the adapter surfaces the bridge's message verbatim, so an
   * unwritable inbox names the path it tried instead of claiming the daemon is
   * down).
   */
  async function post(entry: FeedbackEntry): Promise<{ ok: boolean; error?: string }> {
    // The CONFIGURED project wins. An entry's own `project` is data, and data
    // can come from a durable queue that something other than this adapter
    // wrote — letting it pick the destination directory would make the queue a
    // way to choose where notes land.
    const wire = opts.project === undefined ? entry : { ...entry, project: opts.project };
    try {
      const res = await request({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(wire) });
      if (res.ok) return { ok: true };
      const body: unknown = await res.json().catch(() => null);
      const error = (body as { error?: unknown } | null)?.error;
      return typeof error === "string" && error.trim() !== ""
        ? { ok: false, error }
        : { ok: false, error: `bridge answered ${res.status}` };
    } catch {
      return { ok: false }; // unreachable: no answer to surface
    }
  }

  async function drainQueue(): Promise<void> {
    const { clipboard } = opts;
    const expired: QueuedEntry[] = [];
    let delivered = false;

    for (const item of [...queue]) {
      if (destroyed) break; // stop sending, but still persist what's left
      if ((await post(item.entry)).ok) {
        queue = queue.filter((queued) => queued !== item);
        delivered = true;
        continue;
      }
      item.attempts += 1;
      if (item.attempts >= MAX_ATTEMPTS && clipboard) expired.push(item);
    }

    // One payload for the whole round — writing per entry would have each copy
    // overwrite the last, dropping everything but the final entry.
    if (expired.length > 0 && clipboard) {
      try {
        await clipboard(expired.map((item) => JSON.stringify(item.entry)).join("\n"));
        queue = queue.filter((queued) => !expired.includes(queued));
      } catch {
        // Clipboard refused (no user activation?) — keep the entries queued.
      }
    }

    failedRounds = delivered || queue.length === 0 ? 0 : failedRounds + 1; // reset once anything gets through
    persist();
    notify();
    scheduleRetry();
  }

  function flush(): Promise<void> {
    if (destroyed || queue.length === 0) return Promise.resolve();
    if (flushing) return flushing;
    flushing = drainQueue()
      .catch(() => {
        // Never reject: flush is called from timers and fire-and-forget paths.
      })
      .finally(() => {
        flushing = null;
      });
    return flushing;
  }

  function enqueue(entry: FeedbackEntry): void {
    if (!queue.some((item) => item.entry.id === entry.id)) queue.push({ entry, attempts: 0 });
    persist();
    notify();
  }

  if (queue.length > 0) {
    notify();
    scheduleRetry();
  }

  return {
    async create(entry) {
      // Validate at the schema boundary (docs/design.md): never post or queue an
      // entry that restore() would throw away on the next page load.
      if (!validateEntry(entry)) return { ok: false, queued: false };
      const sent = await post(entry);
      if (sent.ok) {
        failedRounds = 0;
        return { ok: true, queued: false };
      }
      enqueue(entry);
      failedRounds += 1;
      scheduleRetry();
      return sent.error === undefined
        ? { ok: false, queued: true }
        : { ok: false, queued: true, error: sent.error };
    },

    async list() {
      try {
        // No content-type on the GET: it would force a CORS preflight for nothing.
        const res = await request({ method: "GET" }, listUrl());
        if (!res.ok) return [];
        const body: unknown = await res.json();
        const entries = Array.isArray(body)
          ? body
          : (body as { entries?: unknown } | null)?.entries;
        return Array.isArray(entries) ? (entries as FeedbackEntry[]) : [];
      } catch {
        return []; // bridge down — the caller shows an empty panel, not an error
      }
    },

    async remove(id) {
      // The bridge routes the delete on the same wire-level project as create.
      const payload = opts.project ? { id, project: opts.project } : { id };
      try {
        const res = await request({ method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify(payload) });
        if (!res.ok) return false;
        const body: unknown = await res.json().catch(() => null);
        return (body as { ok?: unknown } | null)?.ok !== false;
      } catch {
        return false;
      }
    },

    flush,

    destroy() {
      destroyed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
