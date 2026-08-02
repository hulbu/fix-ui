import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixui, type HtmlTag, type MiddlewareHandler } from "./vite";

let dir: string;
let info: ReturnType<typeof vi.spyOn>;

const discovery = { v: 1, port: 49876, token: "tok-vite", pid: 99 };

async function writeDiscoveryFile(at: string, contents: unknown): Promise<void> {
  await writeFile(
    path.join(at, ".fix-ui.json"),
    typeof contents === "string" ? contents : `${JSON.stringify(contents)}\n`,
    "utf8",
  );
}

/** The parts of a vite dev server this plugin touches, and nothing else. */
function fakeServer(root: string) {
  const routes: Array<{ route: string; handler: MiddlewareHandler }> = [];
  return {
    routes,
    server: {
      config: { root },
      middlewares: {
        use(route: string, handler: MiddlewareHandler) {
          routes.push({ route, handler });
        },
      },
    },
  };
}

function fakeResponse() {
  const headers = new Map<string, string>();
  return {
    headers,
    statusCode: 0,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(body?: string) {
      this.body = body;
    },
  };
}

function script(tags: HtmlTag[]): HtmlTag | undefined {
  return tags.find((tag) => tag.tag === "script");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fixui-vite-"));
  await writeFile(path.join(dir, "package.json"), "{}", "utf8");
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("fixui() vite plugin", () => {
  it("only ever applies to the dev server", () => {
    expect(fixui().apply).toBe("serve");
    expect(fixui().name).toBe("fixui");
  });

  it("injects the global script with the port and token the bridge published", async () => {
    await writeDiscoveryFile(dir, discovery);
    const plugin = fixui({ label: "vite app" });
    const { server } = fakeServer(dir);

    await plugin.configureServer(server);
    const tags = await plugin.transformIndexHtml.handler("<html><body></body></html>");

    const tag = script(tags);
    expect(tag).toBeDefined();
    expect(tag?.injectTo).toBe("body");
    expect(tag?.attrs).toMatchObject({
      "data-fixui": "",
      "data-port": "49876",
      "data-token": "tok-vite",
      "data-label": "vite app",
    });
    expect(String(tag?.attrs?.src)).toContain("fixui");
    expect(info).not.toHaveBeenCalled();
  });

  it("injects nothing into an html document that already has the script", async () => {
    await writeDiscoveryFile(dir, discovery);
    const plugin = fixui();
    const { server } = fakeServer(dir);
    await plugin.configureServer(server);

    const first = await plugin.transformIndexHtml.handler("<html><body></body></html>");
    const src = String(script(first)?.attrs?.src);
    const again = await plugin.transformIndexHtml.handler(
      `<html><body><script src="${src}" data-fixui></script></body></html>`,
    );

    expect(again).toEqual([]);
  });

  it("still injects the picker, and says why, when no bridge has published itself", async () => {
    const plugin = fixui();
    const { server } = fakeServer(dir);

    await plugin.configureServer(server);
    const tag = script(await plugin.transformIndexHtml.handler("<html></html>"));

    expect(tag).toBeDefined();
    expect(tag?.attrs?.["data-port"]).toBeUndefined();
    expect(tag?.attrs?.["data-token"]).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain("fixui dev");
  });

  it("reads the discovery file relative to the vite root, not the process cwd", async () => {
    const root = path.join(dir, "apps", "web");
    await mkdir(root, { recursive: true });
    await writeDiscoveryFile(root, discovery);
    const plugin = fixui();
    const { server } = fakeServer(root);

    await plugin.configureServer(server);
    const tag = script(await plugin.transformIndexHtml.handler("<html></html>"));

    expect(tag?.attrs?.["data-port"]).toBe("49876");
  });

  it("serves the global script bundle at the url it injects", async () => {
    await writeDiscoveryFile(dir, discovery);
    const plugin = fixui();
    const { server, routes } = fakeServer(dir);
    await plugin.configureServer(server);
    const tag = script(await plugin.transformIndexHtml.handler("<html></html>"));

    expect(routes).toHaveLength(1);
    expect(routes[0]?.route).toBe(tag?.attrs?.src);

    const res = fakeResponse();
    await routes[0]?.handler({ url: routes[0].route }, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.body).toBeTruthy();
  });

  it("does not throw on a server object it does not recognize", async () => {
    const plugin = fixui();

    await expect(plugin.configureServer({})).resolves.toBeUndefined();
    await expect(plugin.transformIndexHtml.handler("<html></html>")).resolves.toBeDefined();
  });

  it("treats a malformed discovery file as no bridge", async () => {
    await writeDiscoveryFile(dir, "nonsense");
    const plugin = fixui();
    const { server } = fakeServer(dir);

    await plugin.configureServer(server);
    const tag = script(await plugin.transformIndexHtml.handler("<html></html>"));

    expect(tag?.attrs?.["data-port"]).toBeUndefined();
  });
});
