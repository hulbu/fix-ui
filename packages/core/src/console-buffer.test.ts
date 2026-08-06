import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConsoleBuffer, type ConsoleBuffer } from "./console-buffer.js";

const T0 = "2026-07-31T09:00:00.000Z";
const T1 = "2026-07-31T09:00:05.000Z";

describe("createConsoleBuffer", () => {
  let buffer: ConsoleBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    buffer = createConsoleBuffer();
  });

  afterEach(() => {
    buffer.uninstall();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("dedupes repeated messages into count with updated lastAt", () => {
    buffer.push("TypeError: x is not a function", "app.js");
    vi.setSystemTime(new Date(T1));
    buffer.push("TypeError: x is not a function", "app.js");

    expect(buffer.snapshot()).toEqual([
      { message: "TypeError: x is not a function", source: "app.js", count: 2, lastAt: T1 },
    ]);
  });

  it("moves a repeated message back to the end so the most recent is last", () => {
    buffer.push("a");
    buffer.push("b");
    buffer.push("a");

    expect(buffer.snapshot().map((e) => [e.message, e.count])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
  });

  it("caps at 5 distinct errors, evicting the oldest, most recent last", () => {
    for (let i = 1; i <= 7; i += 1) buffer.push(`error ${i}`);

    expect(buffer.snapshot().map((e) => e.message)).toEqual([
      "error 3",
      "error 4",
      "error 5",
      "error 6",
      "error 7",
    ]);
  });

  it("truncates message to 300 and source to 160 chars", () => {
    buffer.push("m".repeat(400), "s".repeat(300));

    const [error] = buffer.snapshot();
    expect(error!.message).toHaveLength(300);
    expect(error!.source).toHaveLength(160);
  });

  it("captures console.error and error/unhandledrejection events after install, stops after uninstall", () => {
    const original = vi.spyOn(window.console, "error").mockImplementation(() => {});
    buffer.install(window);
    expect(window.console.error).not.toBe(original); // wrapped

    window.console.error("render failed", 42);
    window.dispatchEvent(
      new ErrorEvent("error", { message: "TypeError: nope", filename: "http://localhost/app.js" }),
    );
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: new TypeError("x is not a function") }),
    );

    expect(buffer.snapshot().map((e) => e.message)).toEqual([
      "render failed 42",
      "TypeError: nope",
      "TypeError: x is not a function",
    ]);
    expect(buffer.snapshot()[1]!.source).toBe("http://localhost/app.js");
    expect(original).toHaveBeenCalledWith("render failed", 42); // still reaches the real console

    buffer.uninstall();
    buffer.clear();
    expect(window.console.error).toBe(original); // unwrapped again
    window.console.error("after uninstall");
    window.dispatchEvent(new ErrorEvent("error", { message: "later" }));

    expect(buffer.snapshot()).toEqual([]);
  });

  it("install() is idempotent", () => {
    vi.spyOn(window.console, "error").mockImplementation(() => {});
    buffer.install(window);
    buffer.install(window);

    window.dispatchEvent(new ErrorEvent("error", { message: "once" }));
    window.console.error("twice?");

    expect(buffer.snapshot().map((e) => [e.message, e.count])).toEqual([
      ["once", 1],
      ["twice?", 1],
    ]);
  });

  it("push() feeds the buffer without install", () => {
    buffer.push("manual message", "content-script");

    expect(buffer.snapshot()).toEqual([
      { message: "manual message", source: "content-script", count: 1, lastAt: T0 },
    ]);
  });

  it("clear() empties the buffer and snapshot() hands out copies", () => {
    buffer.push("boom");
    const snapshot = buffer.snapshot();
    snapshot[0]!.count = 99;
    expect(buffer.snapshot()[0]!.count).toBe(1);

    buffer.clear();
    expect(buffer.snapshot()).toEqual([]);
  });

  it("honours custom caps", () => {
    const small = createConsoleBuffer({ maxErrors: 2, maxMessage: 4, maxSource: 3 });
    small.push("first");
    small.push("second", "webpack://x");
    small.push("third");

    expect(small.snapshot()).toEqual([
      { message: "seco", source: "web", count: 1, lastAt: T0 },
      { message: "thir", count: 1, lastAt: T0 },
    ]);
  });
});
