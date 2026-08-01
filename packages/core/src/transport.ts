import { validateEntry, type FeedbackEntry } from "./entry";

/**
 * Talks to the bridge — or to any app-provided endpoint with the same shape.
 * Everything it touches is injectable, because core does no ambient IO.
 *
 * Error handling (docs/design.md): a failed create is queued in memory and in
 * storage, retried with exponential backoff; after MAX_ATTEMPTS failed flushes
 * the entry goes to the clipboard as a last resort and leaves the queue. With
 * no clipboard configured there is no last resort, so it keeps retrying.
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
  create(entry: FeedbackEntry): Promise<{ ok: boolean; queued: boolean }>;
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

  function request(init: RequestInit): Promise<Response> {
    const impl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") return Promise.reject(new Error("no fetch implementation"));
    return impl(opts.endpoint, init);
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

  async function post(entry: FeedbackEntry): Promise<boolean> {
    const wire = opts.project === undefined || entry.project !== undefined
      ? entry
      : { ...entry, project: opts.project };
    try {
      const res = await request({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(wire) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function drainQueue(): Promise<void> {
    let delivered = false;
    for (const item of [...queue]) {
      if (destroyed) break; // stop sending, but still persist what's left
      if (await post(item.entry)) {
        queue = queue.filter((queued) => queued !== item);
        delivered = true;
        continue;
      }
      item.attempts += 1;
      if (item.attempts >= MAX_ATTEMPTS && opts.clipboard) {
        try {
          await opts.clipboard(JSON.stringify(item.entry));
          queue = queue.filter((queued) => queued !== item);
        } catch {
          // Clipboard refused (no user activation?) — keep the entry queued.
        }
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
      if (await post(entry)) {
        failedRounds = 0;
        return { ok: true, queued: false };
      }
      enqueue(entry);
      failedRounds += 1;
      scheduleRetry();
      return { ok: false, queued: true };
    },

    async list() {
      try {
        // No content-type on the GET: it would force a CORS preflight for nothing.
        const res = await request({ method: "GET" });
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
      try {
        const res = await request({ method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ id }) });
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
