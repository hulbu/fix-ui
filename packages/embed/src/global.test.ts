import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FixUiOptions } from "./index";

vi.mock("./index", () => ({
  initFixUi: vi.fn(() => ({ close: () => undefined })),
}));

/**
 * The global build is an IIFE: loading it *is* the API. So every test loads a
 * fresh copy against a DOM it has already set up, and asserts on what the
 * script asked `initFixUi` for.
 */
async function load(): Promise<ReturnType<typeof vi.fn>> {
  vi.resetModules();
  await import("./global");
  const { initFixUi } = await import("./index");
  return vi.mocked(initFixUi) as unknown as ReturnType<typeof vi.fn>;
}

function firstOptions(init: ReturnType<typeof vi.fn>): FixUiOptions {
  expect(init).toHaveBeenCalledTimes(1);
  return (init.mock.calls[0]?.[0] ?? {}) as FixUiOptions;
}

/** `document.currentScript` is a prototype getter; an own property shadows it
 *  for the length of one test. */
function pretendCurrentScript(element: Element | null): void {
  Object.defineProperty(document, "currentScript", { value: element, configurable: true });
}

function tag(attrs: Record<string, string>): HTMLScriptElement {
  const element = document.createElement("script");
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  document.head.append(element);
  return element;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  Reflect.deleteProperty(document, "currentScript");
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the global script", () => {
  it("reads the port, token and label off its own script element", async () => {
    pretendCurrentScript(
      tag({
        "data-fixui": "",
        "data-port": "51000",
        "data-token": "tok-global",
        "data-label": "index.html",
      }),
    );

    expect(firstOptions(await load())).toMatchObject({
      bridgeUrl: "http://127.0.0.1:51000",
      token: "tok-global",
      label: "index.html",
    });
  });

  it("finds itself by [data-fixui] when currentScript is null (defer, async, module)", async () => {
    tag({ "data-fixui": "", "data-port": "51001", "data-token": "tok-deferred" });
    pretendCurrentScript(null);

    expect(firstOptions(await load())).toMatchObject({
      bridgeUrl: "http://127.0.0.1:51001",
      token: "tok-deferred",
    });
  });

  it("mounts the picker anyway when it cannot find its own tag", async () => {
    pretendCurrentScript(null);

    const options = firstOptions(await load());

    expect(options.bridgeUrl).toBeUndefined();
    expect(options.token).toBeUndefined();
  });

  it("ignores a data-port that is not a port", async () => {
    pretendCurrentScript(tag({ "data-fixui": "", "data-port": "banana" }));

    expect(firstOptions(await load()).bridgeUrl).toBeUndefined();
  });

  it("does not take the page down when the embed fails to start", async () => {
    vi.resetModules();
    const { initFixUi } = await import("./index");
    vi.mocked(initFixUi).mockImplementation(() => {
      throw new Error("no DOM for you");
    });

    await expect(import("./global")).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
