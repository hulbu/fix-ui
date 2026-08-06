/**
 * The FeedbackEntry v1 wire format (docs/capture-format.md) and its two
 * boundaries: `buildEntry` produces a conforming entry from what the picker
 * captured, `validateEntry` rejects anything malformed before it hits the
 * network. Entries are read by an LLM every time they're acted on, so the
 * caps below are the product, not paranoia.
 */
export const MAX_ELEMENT_TEXT = 120;
export const MAX_CONSOLE_ERRORS = 5;
export const MAX_CONSOLE_MESSAGE = 300;
export const MAX_CONSOLE_SOURCE = 160;
/** Generous for anything a person types, and small enough that nothing can use
 *  an inbox as storage. The bridge enforces the same numbers at its own HTTP
 *  boundary (src/bridge/server.ts) — keep the two in step. */
export const MAX_NOTE = 10_000;
export const MAX_SELECTOR = 2000;

export interface ConsoleError {
  message: string;
  source?: string;
  count: number;
  lastAt: string;
}

export interface FeedbackEntry {
  v: 1;
  id: string;
  note: string;
  selector: string;
  component?: string;
  elementText?: string;
  url: string;
  viewport: { width: number; height: number };
  userAgent: string;
  createdAt: string;
  consoleErrors?: ConsoleError[];
  /** Wire-only: the bridge routes on it and strips it before writing. */
  project?: string;
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCappedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function isConsoleError(value: unknown): value is ConsoleError {
  if (typeof value !== "object" || value === null) return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.message === "string" &&
    error.message.length <= MAX_CONSOLE_MESSAGE &&
    isCappedString(error.source, MAX_CONSOLE_SOURCE) &&
    typeof error.count === "number" &&
    Number.isFinite(error.count) &&
    typeof error.lastAt === "string"
  );
}

/** Shape + length caps per capture-format.md. Unknown fields are allowed through. */
export function validateEntry(x: unknown): x is FeedbackEntry {
  if (typeof x !== "object" || x === null) return false;
  const entry = x as Record<string, unknown>;

  if (entry.v !== 1) return false;
  if (!isFilledString(entry.id)) return false;
  // Capped as well as filled: an entry that the bridge would refuse must not be
  // queued here, or the transport retries it with backoff forever.
  if (!isFilledString(entry.note) || entry.note.length > MAX_NOTE) return false;
  if (!isFilledString(entry.selector) || entry.selector.length > MAX_SELECTOR) return false;
  if (typeof entry.url !== "string") return false;
  if (typeof entry.userAgent !== "string") return false;
  if (typeof entry.createdAt !== "string") return false;

  const viewport = entry.viewport;
  if (typeof viewport !== "object" || viewport === null) return false;
  const { width, height } = viewport as { width?: unknown; height?: unknown };
  if (typeof width !== "number" || typeof height !== "number") return false;

  if (entry.component !== undefined && typeof entry.component !== "string") return false;
  if (!isCappedString(entry.elementText, MAX_ELEMENT_TEXT)) return false;
  if (entry.project !== undefined && typeof entry.project !== "string") return false;

  if (entry.consoleErrors !== undefined) {
    if (!Array.isArray(entry.consoleErrors)) return false;
    if (entry.consoleErrors.length > MAX_CONSOLE_ERRORS) return false;
    if (!entry.consoleErrors.every(isConsoleError)) return false;
  }

  return true;
}

function capConsoleErrors(errors: ConsoleError[]): ConsoleError[] {
  return errors.slice(-MAX_CONSOLE_ERRORS).map((error) => {
    const message = error.message.slice(0, MAX_CONSOLE_MESSAGE);
    return error.source === undefined
      ? { message, count: error.count, lastAt: error.lastAt }
      : { message, source: error.source.slice(0, MAX_CONSOLE_SOURCE), count: error.count, lastAt: error.lastAt };
  });
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export interface BuildEntryInput {
  note: string;
  selector: string;
  component?: string;
  elementText?: string;
  project?: string;
  consoleErrors?: ConsoleError[];
}

export interface BuildEntryEnv {
  url: string;
  viewport: { width: number; height: number };
  userAgent: string;
  now?: () => Date;
  uuid?: () => string;
}

/** Build a v1 entry, applying the format's caps so the result always validates. */
export function buildEntry(input: BuildEntryInput, env: BuildEntryEnv): FeedbackEntry {
  const elementText = input.elementText?.trim().slice(0, MAX_ELEMENT_TEXT);
  const consoleErrors = capConsoleErrors(input.consoleErrors ?? []);

  // Absent optionals are omitted entirely; field order mirrors capture-format.md.
  return {
    v: 1,
    id: env.uuid?.() ?? randomId(),
    note: input.note.trim().slice(0, MAX_NOTE),
    selector: input.selector.slice(0, MAX_SELECTOR),
    ...(input.component ? { component: input.component } : {}),
    ...(elementText ? { elementText } : {}),
    url: env.url,
    viewport: { width: env.viewport.width, height: env.viewport.height },
    userAgent: env.userAgent,
    createdAt: (env.now?.() ?? new Date()).toISOString(),
    ...(consoleErrors.length > 0 ? { consoleErrors } : {}),
    ...(input.project ? { project: input.project } : {}),
  };
}
