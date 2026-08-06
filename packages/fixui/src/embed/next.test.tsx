import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FixUiOptions } from "./index.js";
import { FixUiScript, resetNoticeForTests } from "./next.js";
import { FixUi } from "./react.js";

let dir: string;
let info: ReturnType<typeof vi.spyOn>;

/** The element `FixUiScript` returned, with its props typed. */
function props(element: ReactElement | null): FixUiOptions {
  expect(element).not.toBeNull();
  return (element as ReactElement<FixUiOptions>).props;
}

async function writeDiscoveryFile(at: string, contents: unknown): Promise<void> {
  await writeFile(
    path.join(at, ".fix-ui.json"),
    typeof contents === "string" ? contents : `${JSON.stringify(contents)}\n`,
    "utf8",
  );
}

const discovery = { v: 1, port: 51234, token: "tok-abc", pid: 4242 };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fixui-next-"));
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  resetNoticeForTests();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("<FixUiScript /> (Next server component)", () => {
  it("renders nothing at all in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await writeDiscoveryFile(dir, discovery);

    expect(await FixUiScript({ cwd: dir })).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("hands the client component the port and token the bridge published", async () => {
    await writeDiscoveryFile(dir, discovery);

    const element = await FixUiScript({ cwd: dir, label: "app router" });

    expect(element?.type).toBe(FixUi);
    expect(props(element)).toMatchObject({
      bridgeUrl: "http://127.0.0.1:51234",
      token: "tok-abc",
      label: "app router",
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("walks up from a nested cwd to the project the discovery file sits in", async () => {
    await writeFile(path.join(dir, "package.json"), "{}", "utf8");
    await writeDiscoveryFile(dir, discovery);
    const nested = path.join(dir, "src", "app", "(marketing)");
    await mkdir(nested, { recursive: true });

    expect(props(await FixUiScript({ cwd: nested }))).toMatchObject({
      bridgeUrl: "http://127.0.0.1:51234",
      token: "tok-abc",
    });
  });

  it("stops at the nearest package.json rather than escaping the project", async () => {
    await writeDiscoveryFile(dir, discovery); // a sibling project's file, one level up
    const project = path.join(dir, "apps", "web");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "package.json"), "{}", "utf8");

    expect(props(await FixUiScript({ cwd: project })).bridgeUrl).toBeUndefined();
  });

  it("still mounts the picker, and says why, when no bridge has published itself", async () => {
    const element = await FixUiScript({ cwd: dir, label: "app" });

    expect(element?.type).toBe(FixUi);
    expect(props(element)).toMatchObject({ label: "app" });
    expect(props(element).bridgeUrl).toBeUndefined();
    expect(props(element).token).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain("fixui dev");
  });

  it("explains itself once, not once per render", async () => {
    await FixUiScript({ cwd: dir });
    await FixUiScript({ cwd: dir });
    await FixUiScript({ cwd: dir });

    expect(info).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed discovery file as no bridge instead of throwing", async () => {
    await writeDiscoveryFile(dir, "{ not json at all");

    expect(props(await FixUiScript({ cwd: dir })).bridgeUrl).toBeUndefined();
  });

  it("treats a discovery file of the wrong shape as no bridge", async () => {
    await writeDiscoveryFile(dir, { v: 2, port: 51234, token: "tok-abc", pid: 1 });

    expect(props(await FixUiScript({ cwd: dir })).bridgeUrl).toBeUndefined();
  });

  it("does not throw when the discovery path is unreadable", async () => {
    await mkdir(path.join(dir, ".fix-ui.json")); // a directory where a file should be

    expect(props(await FixUiScript({ cwd: dir })).bridgeUrl).toBeUndefined();
  });

  it("is usable as JSX in a layout, async and all", () => {
    // The contract with the app is `<FixUiScript />` in app/layout.tsx. If
    // React's types ever stop accepting an async component there, that is a
    // typecheck failure here rather than in somebody's app.
    const element = <FixUiScript label="layout" />;

    expect(element.type).toBe(FixUiScript);
  });

  it("takes no props at all", async () => {
    // Whatever the process cwd holds, rendering must not throw or return junk.
    const element = await FixUiScript();

    expect(element?.type).toBe(FixUi);
  });
});
