import {
  MAX_CONSOLE_ERRORS,
  MAX_CONSOLE_MESSAGE,
  MAX_CONSOLE_SOURCE,
  type ConsoleError,
} from "./entry";

/**
 * Deduped ring buffer of page errors (docs/capture-format.md): the last few
 * distinct errors, most recent last, so an entry can carry what the page was
 * screaming about without carrying a log file. Warnings are never collected.
 */
export interface ConsoleBuffer {
  /** Wrap `error`/`unhandledrejection` events and `console.error` on `target`. Idempotent. */
  install(target?: Window): void;
  uninstall(): void;
  /** Manual feed — the extension's MAIN-world script postMessages errors in. */
  push(message: string, source?: string): void;
  snapshot(): ConsoleError[];
  clear(): void;
}

export interface ConsoleBufferOptions {
  maxErrors?: number;
  maxMessage?: number;
  maxSource?: number;
}

type ConsoleLike = { error: (...args: unknown[]) => void };

interface Installation {
  target: Window;
  console: ConsoleLike | undefined;
  originalError: ((...args: unknown[]) => void) | undefined;
}

/** "TypeError: x is not a function" for errors; something readable for anything else. */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value); // circular or exotic — String() still says something
  }
}

export function createConsoleBuffer(opts: ConsoleBufferOptions = {}): ConsoleBuffer {
  const maxErrors = opts.maxErrors ?? MAX_CONSOLE_ERRORS;
  const maxMessage = opts.maxMessage ?? MAX_CONSOLE_MESSAGE;
  const maxSource = opts.maxSource ?? MAX_CONSOLE_SOURCE;

  const errors: ConsoleError[] = [];
  let installation: Installation | null = null;

  function push(message: string, source?: string): void {
    const text = message.trim().slice(0, maxMessage);
    if (!text) return;
    const from = source?.slice(0, maxSource);
    const lastAt = new Date().toISOString();

    const index = errors.findIndex((error) => error.message === text);
    if (index >= 0) {
      // Repeat: bump the count and move it to the end — most recent last.
      const existing = errors.splice(index, 1)[0];
      existing.count += 1;
      existing.lastAt = lastAt;
      if (existing.source === undefined && from !== undefined) existing.source = from;
      errors.push(existing);
      return;
    }

    errors.push(
      from === undefined
        ? { message: text, count: 1, lastAt }
        : { message: text, source: from, count: 1, lastAt },
    );
    while (errors.length > maxErrors) errors.shift();
  }

  function onError(event: Event): void {
    const { message, error, filename } = event as ErrorEvent;
    const text = message || (error === undefined ? "" : formatValue(error));
    push(text, typeof filename === "string" ? filename : undefined);
  }

  function onRejection(event: Event): void {
    push(formatValue((event as PromiseRejectionEvent).reason));
  }

  function install(target?: Window): void {
    if (installation) return;
    const win = target ?? (typeof window === "undefined" ? undefined : window);
    if (!win) return;

    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);

    // `console` lives on the global object, not on lib.dom's `Window` interface.
    const wrapped = (win as Window & { console?: ConsoleLike }).console;
    let originalError: ((...args: unknown[]) => void) | undefined;
    if (wrapped && typeof wrapped.error === "function") {
      originalError = wrapped.error;
      wrapped.error = (...args: unknown[]) => {
        push(args.map(formatValue).join(" "));
        originalError?.apply(wrapped, args);
      };
    }

    installation = { target: win, console: wrapped, originalError };
  }

  function uninstall(): void {
    if (!installation) return;
    const { target, console: wrapped, originalError } = installation;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    if (wrapped && originalError) wrapped.error = originalError;
    installation = null;
  }

  return {
    install,
    uninstall,
    push,
    snapshot: () => errors.map((error) => ({ ...error })),
    clear: () => {
      errors.length = 0;
    },
  };
}
