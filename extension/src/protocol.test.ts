import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_URL,
  MAX_MAIN_MESSAGE,
  createSseParser,
  decodeFetchResponse,
  deliverableTabs,
  encodeFetchRequest,
  isAllowedBridgeUrl,
  lookupProject,
  originsInBucket,
  normalizeBridgeUrl,
  originOf,
  parseFetchRequest,
  parseMainMessage,
  parseOriginMap,
  parseReviewRequested,
  serializeOriginMap,
  verdictReviewId,
} from "./protocol";

describe("parseOriginMap", () => {
  it("parses one origin=project mapping per line", () => {
    const { mappings, errors } = parseOriginMap(
      "https://app.example.com=/Users/me/app\nhttp://localhost:3000=/Users/me/site",
    );
    expect(errors).toEqual([]);
    expect(mappings).toEqual([
      { origin: "https://app.example.com", project: "/Users/me/app" },
      { origin: "http://localhost:3000", project: "/Users/me/site" },
    ]);
  });

  it("ignores blank lines and # comments", () => {
    const { mappings, errors } = parseOriginMap(
      "# the staging app\n\n  \nhttps://app.example.com=/Users/me/app\n",
    );
    expect(errors).toEqual([]);
    expect(mappings).toHaveLength(1);
  });

  it("normalises the origin (trailing slash, path, default port, case)", () => {
    const { mappings } = parseOriginMap(
      "https://App.Example.com/dashboard/=/Users/me/app\nhttps://other.example.com:443=/Users/me/b",
    );
    expect(mappings.map((m) => m.origin)).toEqual([
      "https://app.example.com",
      "https://other.example.com",
    ]);
  });

  it("splits on the first = so project paths may contain one", () => {
    const { mappings, errors } = parseOriginMap("https://a.example.com=/Users/me/a=b");
    expect(errors).toEqual([]);
    expect(mappings[0]?.project).toBe("/Users/me/a=b");
  });

  it("reports lines with no = and keeps the good ones", () => {
    const { mappings, errors } = parseOriginMap(
      "https://a.example.com=/Users/me/a\nnonsense\nhttps://b.example.com=/Users/me/b",
    );
    expect(mappings).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 2, text: "nonsense" });
    expect(errors[0]?.reason).toMatch(/origin=\/absolute\/path/i);
  });

  it("reports a non-http(s) or unparseable origin", () => {
    const { mappings, errors } = parseOriginMap(
      "file:///etc=/Users/me/a\nnot a url=/Users/me/b\nftp://x.example.com=/Users/me/c",
    );
    expect(mappings).toEqual([]);
    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error.reason).toMatch(/http/i);
  });

  it("reports a project that is not an absolute path", () => {
    const { mappings, errors } = parseOriginMap(
      "https://a.example.com=relative/path\nhttps://b.example.com=  ",
    );
    expect(mappings).toEqual([]);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error.reason).toMatch(/absolute path/i);
  });

  it("keeps the first of a duplicated origin and reports the rest", () => {
    const { mappings, errors } = parseOriginMap(
      "https://a.example.com=/Users/me/first\nhttps://a.example.com/=/Users/me/second",
    );
    expect(mappings).toEqual([{ origin: "https://a.example.com", project: "/Users/me/first" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.reason).toMatch(/duplicate/i);
  });

  it("answers empty for empty input", () => {
    expect(parseOriginMap("")).toEqual({ mappings: [], errors: [] });
    expect(parseOriginMap("\n\n")).toEqual({ mappings: [], errors: [] });
  });

  it("round-trips through serializeOriginMap", () => {
    const text = "https://app.example.com=/Users/me/app\nhttp://localhost:3000=/Users/me/site";
    const { mappings } = parseOriginMap(text);
    expect(serializeOriginMap(mappings)).toBe(text);
    expect(parseOriginMap(serializeOriginMap(mappings)).mappings).toEqual(mappings);
  });
});

describe("lookupProject", () => {
  const { mappings } = parseOriginMap(
    "https://app.example.com=/Users/me/app\nhttp://localhost:3000=/Users/me/site",
  );

  it("matches an exact origin", () => {
    expect(lookupProject(mappings, "https://app.example.com")).toBe("/Users/me/app");
    expect(lookupProject(mappings, "http://localhost:3000")).toBe("/Users/me/site");
  });

  it("does not match by wildcard, subdomain, port or scheme", () => {
    expect(lookupProject(mappings, "https://other.example.com")).toBeUndefined();
    expect(lookupProject(mappings, "https://www.app.example.com")).toBeUndefined();
    expect(lookupProject(mappings, "http://app.example.com")).toBeUndefined();
    expect(lookupProject(mappings, "http://localhost:3001")).toBeUndefined();
  });

  it("answers undefined for an unknown or missing origin", () => {
    expect(lookupProject(mappings, undefined)).toBeUndefined();
    expect(lookupProject([], "https://app.example.com")).toBeUndefined();
  });
});

describe("originOf", () => {
  it("extracts the origin of an http(s) page url", () => {
    expect(originOf("https://app.example.com/a/b?c=d#e")).toBe("https://app.example.com");
    expect(originOf("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("refuses non-http(s) and unparseable urls", () => {
    expect(originOf("chrome://extensions")).toBeUndefined();
    expect(originOf("about:blank")).toBeUndefined();
    expect(originOf("file:///Users/me/page.html")).toBeUndefined();
    expect(originOf(undefined)).toBeUndefined();
    expect(originOf("")).toBeUndefined();
  });
});

describe("normalizeBridgeUrl", () => {
  it("defaults to the loopback bridge", () => {
    expect(DEFAULT_BRIDGE_URL).toBe("http://127.0.0.1:3499");
    expect(normalizeBridgeUrl("")).toBe(DEFAULT_BRIDGE_URL);
    expect(normalizeBridgeUrl("   ")).toBe(DEFAULT_BRIDGE_URL);
  });

  it("trims trailing slashes and drops any path", () => {
    expect(normalizeBridgeUrl("http://127.0.0.1:3499/")).toBe("http://127.0.0.1:3499");
    expect(normalizeBridgeUrl("http://localhost:3499/entries")).toBe("http://localhost:3499");
  });

  it("assumes http:// when the scheme is missing", () => {
    expect(normalizeBridgeUrl("127.0.0.1:3499")).toBe("http://127.0.0.1:3499");
    expect(normalizeBridgeUrl("localhost:4000")).toBe("http://localhost:4000");
  });

  it("refuses anything the manifest has no host permission for", () => {
    expect(normalizeBridgeUrl("https://127.0.0.1:3499")).toBeNull();
    expect(normalizeBridgeUrl("http://example.com")).toBeNull();
    expect(normalizeBridgeUrl("http://192.168.1.4:3499")).toBeNull();
    expect(normalizeBridgeUrl("¯\\_(ツ)_/¯")).toBeNull();
  });
});

describe("isAllowedBridgeUrl", () => {
  it("allows loopback http only", () => {
    expect(isAllowedBridgeUrl("http://127.0.0.1:3499/entries")).toBe(true);
    expect(isAllowedBridgeUrl("http://localhost:3499/reviews/abc/verdict")).toBe(true);
  });

  it("refuses every other host and scheme", () => {
    expect(isAllowedBridgeUrl("https://127.0.0.1:3499/entries")).toBe(false);
    expect(isAllowedBridgeUrl("http://evil.example.com/entries")).toBe(false);
    expect(isAllowedBridgeUrl("http://127.0.0.1.evil.com/entries")).toBe(false);
    expect(isAllowedBridgeUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedBridgeUrl("not a url")).toBe(false);
  });
});

describe("deliverableTabs", () => {
  const APP = "https://app.example.com";
  const SHOP = "https://shop.example.com";
  const NEWS = "https://news.example.com";

  it("delivers a project's review to every tab mapped to it", () => {
    const tabs = {
      "1": { origin: APP, project: "/repo/app" },
      "2": { origin: APP, project: "/repo/app" },
      "3": { origin: SHOP, project: "/repo/shop" },
    };
    expect(deliverableTabs(tabs, "/repo/app")).toEqual([1, 2]);
    expect(deliverableTabs(tabs, "/repo/shop")).toEqual([3]);
    expect(deliverableTabs(tabs, "/repo/nothing")).toEqual([]);
  });

  it("delivers to the unmapped bucket while one origin occupies it", () => {
    const tabs = { "1": { origin: APP }, "2": { origin: APP } };
    expect(deliverableTabs(tabs, "")).toEqual([1, 2]);
  });

  /**
   * The bug this rule exists for: every unmapped origin shares the `""` bucket,
   * because "unmapped" only says the notes go to the bridge's own cwd. A review
   * for that default project would raise the agent's prompt on whatever
   * unrelated site also happens to be switched on — and an Approve clicked
   * there resolves the real review.
   */
  it("refuses the unmapped bucket once a second origin joins it", () => {
    const tabs = { "1": { origin: APP }, "2": { origin: NEWS } };
    expect(deliverableTabs(tabs, "")).toEqual([]);

    // Mapping one of them is the fix: the other is alone in the bucket again.
    const mapped = { "1": { origin: APP, project: "/repo/app" }, "2": { origin: NEWS } };
    expect(deliverableTabs(mapped, "")).toEqual([2]);
    expect(deliverableTabs(mapped, "/repo/app")).toEqual([1]);
  });

  /** Mapped projects are explicit, so sharing one across origins is a choice. */
  it("still delivers a mapped project shared by two origins", () => {
    const tabs = {
      "1": { origin: APP, project: "/repo/app" },
      "2": { origin: SHOP, project: "/repo/app" },
    };
    expect(deliverableTabs(tabs, "/repo/app")).toEqual([1, 2]);
  });

  it("reports the origins in a bucket", () => {
    const tabs = { "1": { origin: APP }, "2": { origin: APP }, "3": { origin: NEWS, project: "/n" } };
    expect([...originsInBucket(tabs, "")]).toEqual([APP]);
    expect([...originsInBucket(tabs, "/n")]).toEqual([NEWS]);
  });
});

describe("fetch proxy shaping", () => {
  /** What the options page configured — the ONLY destination the proxy allows. */
  const BRIDGE = "http://127.0.0.1:3499";

  it("encodes a core transport POST", () => {
    const request = encodeFetchRequest("http://127.0.0.1:3499/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"v":1}',
    });
    expect(request).toEqual({
      type: "fixui:fetch",
      url: "http://127.0.0.1:3499/entries",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"v":1}',
    });
  });

  it("defaults the method and omits an absent body", () => {
    const request = encodeFetchRequest("http://127.0.0.1:3499/entries");
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.headers).toEqual({});
  });

  it("normalises Headers and entry-pair header forms", () => {
    expect(
      encodeFetchRequest("http://127.0.0.1:3499/entries", {
        headers: [["Content-Type", "application/json"]],
      }).headers,
    ).toEqual({ "content-type": "application/json" });
  });

  it("refuses a body it cannot forward as a string", () => {
    expect(() =>
      encodeFetchRequest("http://127.0.0.1:3499/entries", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      }),
    ).toThrow(/body/i);
  });

  it("round-trips through the background-side validator", () => {
    const request = encodeFetchRequest("http://127.0.0.1:3499/entries", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: '{"id":"1"}',
    });
    expect(parseFetchRequest(JSON.parse(JSON.stringify(request)), BRIDGE)).toEqual(request);
  });

  it("rejects fetch requests that are malformed or off-bridge", () => {
    expect(parseFetchRequest(null, BRIDGE)).toBeNull();
    expect(
      parseFetchRequest({ type: "something-else", url: "http://127.0.0.1:3499/" }, BRIDGE),
    ).toBeNull();
    expect(parseFetchRequest({ type: "fixui:fetch" }, BRIDGE)).toBeNull();
    expect(
      parseFetchRequest(
        { type: "fixui:fetch", url: "https://evil.example.com", method: "GET", headers: {} },
        BRIDGE,
      ),
    ).toBeNull();
    expect(
      parseFetchRequest(
        { type: "fixui:fetch", url: "http://127.0.0.1:3499/", method: 42, headers: {} },
        BRIDGE,
      ),
    ).toBeNull();
    expect(
      parseFetchRequest(
        { type: "fixui:fetch", url: "http://127.0.0.1:3499/", method: "POST", headers: { a: 1 } },
        BRIDGE,
      ),
    ).toBeNull();
  });

  /**
   * The check the error message always claimed: "not for the local bridge" used
   * to mean nothing more than "some http loopback URL", so a page that could
   * talk a content script into a proxied fetch reached every other service on
   * the machine — an Ollama, an Elasticsearch, a Docker socket on TCP — and got
   * the whole response body back.
   */
  it("refuses loopback destinations that are not the configured bridge", () => {
    const otherPort = {
      type: "fixui:fetch",
      url: "http://127.0.0.1:11434/api/generate",
      method: "POST",
      headers: {},
      body: '{"model":"llama3"}',
    };
    expect(parseFetchRequest(otherPort, BRIDGE)).toBeNull();
    // Same port, other loopback name: still a different origin.
    expect(
      parseFetchRequest({ ...otherPort, url: "http://localhost:3499/entries" }, BRIDGE),
    ).toBeNull();
    // And the configured one still goes through, path and all.
    expect(
      parseFetchRequest({ ...otherPort, url: `${BRIDGE}/entries` }, BRIDGE),
    ).not.toBeNull();
  });

  it("decodes a successful proxied response", () => {
    expect(
      decodeFetchResponse({ ok: true, status: 200, statusText: "OK", body: '{"ok":true}' }),
    ).toEqual({ status: 200, statusText: "OK", body: '{"ok":true}' });
  });

  it("passes a background-side failure through as a throw", () => {
    expect(() => decodeFetchResponse({ ok: false, error: "Failed to fetch" })).toThrow(
      /Failed to fetch/,
    );
    // A dead service worker answers `undefined` — that has to look like a
    // network failure, so core's transport queues the entry instead of losing it.
    expect(() => decodeFetchResponse(undefined)).toThrow();
    expect(() => decodeFetchResponse({ ok: true, status: "200" })).toThrow();
  });
});

describe("parseMainMessage", () => {
  const wrap = (payload: Record<string, unknown>) => ({ source: "fixui-main", ...payload });

  it("accepts a console error with an optional source reference", () => {
    expect(parseMainMessage(wrap({ kind: "console-error", message: "  boom  " }))).toEqual({
      kind: "console-error",
      message: "boom",
    });
    expect(
      parseMainMessage(wrap({ kind: "console-error", message: "boom", sourceRef: "app.js:1" })),
    ).toEqual({ kind: "console-error", message: "boom", source: "app.js:1" });
  });

  it("refuses anything that is not ours", () => {
    expect(parseMainMessage(null)).toBeNull();
    expect(parseMainMessage("fixui-main")).toBeNull();
    expect(parseMainMessage({ kind: "console-error", message: "boom" })).toBeNull();
    expect(parseMainMessage(wrap({ kind: "who-knows", message: "boom" }))).toBeNull();
    expect(parseMainMessage(wrap({ kind: "console-error" }))).toBeNull();
  });

  it("refuses a non-string console message rather than pushing it into the buffer", () => {
    for (const message of [42, null, { toString: () => "boom" }, ["boom"], true]) {
      expect(parseMainMessage(wrap({ kind: "console-error", message }))).toBeNull();
    }
    expect(parseMainMessage(wrap({ kind: "console-error", message: "   " }))).toBeNull();
  });

  it("caps a hostile giant message before it reaches the buffer", () => {
    const parsed = parseMainMessage(wrap({ kind: "console-error", message: "x".repeat(50_000) }));
    expect(parsed).not.toBeNull();
    expect((parsed as { message: string }).message).toHaveLength(MAX_MAIN_MESSAGE);
  });

  it("drops a source reference that is not a short string", () => {
    expect(
      parseMainMessage(wrap({ kind: "console-error", message: "boom", sourceRef: { url: "x" } })),
    ).toEqual({ kind: "console-error", message: "boom" });
    const parsed = parseMainMessage(
      wrap({ kind: "console-error", message: "boom", sourceRef: "s".repeat(5_000) }),
    );
    expect((parsed as { source: string }).source.length).toBeLessThanOrEqual(300);
  });

  it("accepts a component name answer keyed by its query token", () => {
    expect(parseMainMessage(wrap({ kind: "component-name", token: 7, name: "PricingTable" }))).toEqual(
      { kind: "component-name", token: 7, name: "PricingTable" },
    );
    expect(parseMainMessage(wrap({ kind: "component-name", token: 7 }))).toEqual({
      kind: "component-name",
      token: 7,
    });
  });

  it("refuses a component answer with no usable token", () => {
    expect(parseMainMessage(wrap({ kind: "component-name", name: "Foo" }))).toBeNull();
    expect(parseMainMessage(wrap({ kind: "component-name", token: "7", name: "Foo" }))).toBeNull();
    expect(parseMainMessage(wrap({ kind: "component-name", token: 1.5 }))).toBeNull();
    expect(parseMainMessage(wrap({ kind: "component-name", token: Number.NaN }))).toBeNull();
  });

  it("drops a component name that is not a short, printable string", () => {
    const nameless = { kind: "component-name", token: 1 };
    expect(parseMainMessage(wrap({ ...nameless, name: 42 }))).toEqual(nameless);
    expect(parseMainMessage(wrap({ ...nameless, name: "A".repeat(500) }))).toEqual(nameless);
    expect(parseMainMessage(wrap({ ...nameless, name: "Foo\nBar" }))).toEqual(nameless);
    expect(parseMainMessage(wrap({ ...nameless, name: "" }))).toEqual(nameless);
  });

  it("never throws on a hostile payload", () => {
    const hostile: Record<string, unknown> = { source: "fixui-main", kind: "console-error" };
    Object.defineProperty(hostile, "message", {
      enumerable: true,
      get() {
        throw new Error("gotcha");
      },
    });
    expect(() => parseMainMessage(hostile)).not.toThrow();
    expect(parseMainMessage(hostile)).toBeNull();
  });
});

describe("createSseParser", () => {
  it("frames one event out of a complete chunk", () => {
    const parser = createSseParser();
    expect(parser.push('event: review-requested\ndata: {"reviewId":"r1"}\n\n')).toEqual([
      { event: "review-requested", data: '{"reviewId":"r1"}' },
    ]);
  });

  it("waits for the blank line before emitting", () => {
    const parser = createSseParser();
    expect(parser.push("event: review-requested\n")).toEqual([]);
    expect(parser.push('data: {"reviewId":')).toEqual([]);
    expect(parser.push('"r1"}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "review-requested", data: '{"reviewId":"r1"}' }]);
  });

  it("skips the bridge's comment heartbeats", () => {
    const parser = createSseParser();
    expect(parser.push(": connected\n\n: heartbeat\n\n")).toEqual([]);
    expect(parser.push("event: review-cancelled\ndata: {}\n\n")).toEqual([
      { event: "review-cancelled", data: "{}" },
    ]);
  });

  it("emits several events from one chunk and tolerates CRLF", () => {
    const parser = createSseParser();
    expect(parser.push("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("joins multi-line data and defaults the event name to message", () => {
    const parser = createSseParser();
    expect(parser.push("data: one\ndata: two\n\n")).toEqual([
      { event: "message", data: "one\ntwo" },
    ]);
  });

  it("ignores unknown fields and dispatches nothing for a data-less block", () => {
    const parser = createSseParser();
    expect(parser.push("id: 9\nretry: 1000\n\n")).toEqual([]);
  });
});

describe("verdictReviewId", () => {
  it("recognises the verdict endpoint and decodes the id", () => {
    expect(verdictReviewId("http://127.0.0.1:3499/reviews/r1/verdict")).toBe("r1");
    expect(verdictReviewId("http://127.0.0.1:3499/reviews/a%20b/verdict")).toBe("a b");
  });

  it("ignores every other bridge url", () => {
    expect(verdictReviewId("http://127.0.0.1:3499/entries")).toBeUndefined();
    expect(verdictReviewId("http://127.0.0.1:3499/reviews/r1")).toBeUndefined();
    expect(verdictReviewId("http://127.0.0.1:3499/reviews//verdict")).toBeUndefined();
    expect(verdictReviewId("nonsense")).toBeUndefined();
  });
});

describe("parseReviewRequested", () => {
  it("accepts the bridge's review-requested payload", () => {
    expect(
      parseReviewRequested(
        JSON.stringify({ reviewId: "r1", prompt: "Review the pricing table", timeoutSeconds: 600 }),
      ),
    ).toEqual({ reviewId: "r1", prompt: "Review the pricing table", timeoutSeconds: 600 });
  });

  it("keeps a string url and drops mistyped optionals", () => {
    expect(
      parseReviewRequested(
        JSON.stringify({ reviewId: "r1", prompt: "p", url: "http://localhost:3000/#pricing" }),
      ),
    ).toEqual({ reviewId: "r1", prompt: "p", url: "http://localhost:3000/#pricing" });
    expect(parseReviewRequested(JSON.stringify({ reviewId: "r1", prompt: "p", url: 7, timeoutSeconds: "x" }))).toEqual({
      reviewId: "r1",
      prompt: "p",
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseReviewRequested("not json")).toBeNull();
    expect(parseReviewRequested("[]")).toBeNull();
    expect(parseReviewRequested(JSON.stringify({ prompt: "p" }))).toBeNull();
    expect(parseReviewRequested(JSON.stringify({ reviewId: "r1" }))).toBeNull();
    expect(parseReviewRequested(JSON.stringify({ reviewId: "", prompt: "p" }))).toBeNull();
  });
});
