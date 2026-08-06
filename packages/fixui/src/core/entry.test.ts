import { describe, expect, it } from "vitest";

import {
  buildEntry,
  MAX_NOTE,
  MAX_SELECTOR,
  validateEntry,
  type ConsoleError,
  type FeedbackEntry,
} from "./entry.js";

const validEntry: FeedbackEntry = {
  v: 1,
  id: "0f8a1c2e-1111-4222-8333-444455556666",
  note: "make this button bigger",
  selector: "#pricing button.mt-5",
  component: "WaitlistModal",
  elementText: "Continue",
  url: "http://localhost:4001/#pricing",
  viewport: { width: 1579, height: 933 },
  userAgent: "Mozilla/5.0 (Macintosh)",
  createdAt: "2026-07-31T09:00:00.000Z",
};

const env = {
  url: "http://localhost:4001/#pricing",
  viewport: { width: 1579, height: 933 },
  userAgent: "Mozilla/5.0 (Macintosh)",
  now: () => new Date("2026-07-31T09:00:00.000Z"),
  uuid: () => "fixed-uuid",
};

function consoleError(message: string, over: Partial<ConsoleError> = {}): ConsoleError {
  return { message, count: 1, lastAt: "2026-07-31T08:59:41.000Z", ...over };
}

describe("validateEntry", () => {
  it("accepts a valid v1 entry and rejects missing note/selector, wrong types, overlong elementText", () => {
    expect(validateEntry(validEntry)).toBe(true);

    // required fields missing or blank
    expect(validateEntry({ ...validEntry, note: undefined })).toBe(false);
    expect(validateEntry({ ...validEntry, note: "   " })).toBe(false);
    expect(validateEntry({ ...validEntry, selector: undefined })).toBe(false);
    expect(validateEntry({ ...validEntry, selector: "" })).toBe(false);
    expect(validateEntry({ ...validEntry, id: "" })).toBe(false);

    // wrong types
    expect(validateEntry({ ...validEntry, v: 2 })).toBe(false);
    expect(validateEntry({ ...validEntry, note: 42 })).toBe(false);
    expect(validateEntry({ ...validEntry, component: 7 })).toBe(false);
    expect(validateEntry({ ...validEntry, viewport: undefined })).toBe(false);
    expect(validateEntry({ ...validEntry, viewport: { width: "1579", height: 933 } })).toBe(false);
    expect(validateEntry({ ...validEntry, createdAt: 1754000000000 })).toBe(false);
    expect(validateEntry(null)).toBe(false);
    expect(validateEntry("nope")).toBe(false);
    expect(validateEntry(undefined)).toBe(false);

    // elementText cap — 120 chars
    expect(validateEntry({ ...validEntry, elementText: "x".repeat(120) })).toBe(true);
    expect(validateEntry({ ...validEntry, elementText: "x".repeat(121) })).toBe(false);
  });

  it("enforces the consoleErrors caps and accepts the wire-only project field", () => {
    expect(validateEntry({ ...validEntry, consoleErrors: [consoleError("boom", { source: "app.js" })] })).toBe(true);
    expect(validateEntry({ ...validEntry, consoleErrors: [] })).toBe(true);

    // max 5 distinct errors, message ≤ 300, source ≤ 160
    const five = Array.from({ length: 5 }, (_, i) => consoleError(`boom ${i}`));
    expect(validateEntry({ ...validEntry, consoleErrors: five })).toBe(true);
    expect(validateEntry({ ...validEntry, consoleErrors: [...five, consoleError("boom 5")] })).toBe(false);
    expect(validateEntry({ ...validEntry, consoleErrors: [consoleError("x".repeat(301))] })).toBe(false);
    expect(validateEntry({ ...validEntry, consoleErrors: [consoleError("boom", { source: "s".repeat(161) })] })).toBe(
      false,
    );
    expect(validateEntry({ ...validEntry, consoleErrors: [{ message: "boom" }] })).toBe(false);
    expect(validateEntry({ ...validEntry, consoleErrors: "boom" })).toBe(false);

    expect(validateEntry({ ...validEntry, project: "/Users/me/app" })).toBe(true);
    expect(validateEntry({ ...validEntry, project: 5 })).toBe(false);
  });

  it("accepts unknown fields so the format stays forward compatible", () => {
    expect(validateEntry({ ...validEntry, screenshot: "img/abc.png" })).toBe(true);
  });
});

describe("buildEntry", () => {
  it("buildEntry stamps v:1, uuid, ISO createdAt, env fields, and omits empty consoleErrors", () => {
    const entry = buildEntry(
      { note: "  make this button bigger  ", selector: "#cta", component: "Hero", elementText: "Go", consoleErrors: [] },
      env,
    );

    expect(entry).toEqual({
      v: 1,
      id: "fixed-uuid",
      note: "make this button bigger",
      selector: "#cta",
      component: "Hero",
      elementText: "Go",
      url: "http://localhost:4001/#pricing",
      viewport: { width: 1579, height: 933 },
      userAgent: "Mozilla/5.0 (Macintosh)",
      createdAt: "2026-07-31T09:00:00.000Z",
    });
    expect(Object.keys(entry)).not.toContain("consoleErrors");
    expect(Object.keys(entry)).not.toContain("project");
    expect(validateEntry(entry)).toBe(true);
  });

  it("omits optional fields that were not supplied and carries project + consoleErrors through", () => {
    const bare = buildEntry({ note: "fix", selector: "button" }, env);
    expect(Object.keys(bare).sort()).toEqual(
      ["createdAt", "id", "note", "selector", "url", "userAgent", "v", "viewport"].sort(),
    );

    const full = buildEntry(
      { note: "fix", selector: "button", project: "/Users/me/app", consoleErrors: [consoleError("boom")] },
      env,
    );
    expect(full.project).toBe("/Users/me/app");
    expect(full.consoleErrors).toEqual([consoleError("boom")]);
  });

  it("truncates elementText to 120 chars and caps consoleErrors to the v1 limits", () => {
    const entry = buildEntry(
      {
        note: "fix",
        selector: "button",
        elementText: `  ${"x".repeat(200)}  `,
        consoleErrors: Array.from({ length: 7 }, (_, i) =>
          consoleError(`${i}:${"m".repeat(400)}`, { source: "s".repeat(200) }),
        ),
      },
      env,
    );

    expect(entry.elementText).toHaveLength(120);
    expect(entry.consoleErrors).toHaveLength(5);
    expect(entry.consoleErrors![0]!.message.startsWith("2:")).toBe(true); // oldest two dropped
    expect(entry.consoleErrors![0]!.message).toHaveLength(300);
    expect(entry.consoleErrors![0]!.source).toHaveLength(160);
    expect(validateEntry(entry)).toBe(true);
  });

  /**
   * The bridge refuses an over-long note or selector at its HTTP boundary
   * (src/bridge/server.ts). Core has to agree, in both directions: an
   * entry it BUILDS must always be one the bridge accepts, and one it merely
   * validates must be rejected here rather than queued and retried forever.
   */
  it("caps note and selector, and refuses to validate anything past the cap", () => {
    const entry = buildEntry(
      { note: "x".repeat(MAX_NOTE + 500), selector: "d".repeat(MAX_SELECTOR + 500) },
      { url: "http://x/", viewport: { width: 10, height: 20 }, userAgent: "UA" },
    );

    expect(entry.note).toHaveLength(MAX_NOTE);
    expect(entry.selector).toHaveLength(MAX_SELECTOR);
    expect(validateEntry(entry)).toBe(true);

    expect(validateEntry({ ...validEntry, note: "x".repeat(MAX_NOTE + 1) })).toBe(false);
    expect(validateEntry({ ...validEntry, selector: "d".repeat(MAX_SELECTOR + 1) })).toBe(false);
  });

  it("falls back to a generated id and the current time when no now/uuid is injected", () => {
    const before = Date.now();
    const a = buildEntry(
      { note: "fix", selector: "button" },
      { url: "http://x/", viewport: { width: 10, height: 20 }, userAgent: "UA" },
    );
    const b = buildEntry(
      { note: "fix", selector: "button" },
      { url: "http://x/", viewport: { width: 10, height: 20 }, userAgent: "UA" },
    );

    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(0);
    expect(Date.parse(a.createdAt)).toBeGreaterThanOrEqual(before);
    expect(a.createdAt).toBe(new Date(a.createdAt).toISOString());
  });
});
