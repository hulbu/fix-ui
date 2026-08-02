/**
 * The Vite adapter — one line in `vite.config.ts`:
 *
 * ```ts
 * import { fixui } from "@hulbu/fixui/vite";
 * export default defineConfig({ plugins: [fixui()] });
 * ```
 *
 * Vite has no server component to read the bridge's `0600` discovery file from,
 * but it does have a server: the plugin reads the file in Node and inlines the
 * port and token as `data-` attributes on the script tag it injects into
 * `index.html`. The script itself is `dist/fixui.global.js` — the same IIFE the
 * plain-HTML adapter uses — served from this package by a middleware, so
 * nothing has to be copied into the app's `public/`.
 *
 * `apply: "serve"` is the production safety: this plugin does not exist during
 * `vite build`, so no build output can ever carry the picker or a token.
 *
 * Types here are structural on purpose. The embed takes no dependency on vite —
 * not even a devDependency for types — so the returned object is described by
 * its shape and is assignable to vite's `Plugin` because it is a subset of it.
 */
import { readFile } from "node:fs/promises";

import { findDiscovery, noBridgeNotice, type Discovery } from "./find-discovery";

/** A subset of vite's `HtmlTagDescriptor`. */
export interface HtmlTag {
  tag: string;
  attrs?: Record<string, string | boolean | undefined>;
  injectTo?: "body";
}

/** A subset of node's `ServerResponse` — what serving one file needs. */
export interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export type MiddlewareHandler = (
  req: unknown,
  res: ResponseLike,
  next?: () => void,
) => void | Promise<void>;

/** A subset of vite's `Plugin`, structurally assignable to it. */
export interface FixUiVitePlugin {
  name: string;
  apply: "serve";
  configureServer(server: unknown): Promise<void>;
  transformIndexHtml: {
    order: "post";
    handler(html: string): Promise<HtmlTag[]>;
  };
}

export interface FixUiViteOptions {
  /** A human name for this page on the review channel — the agent sees it in
   *  `list_surfaces`. */
  label?: string;
}

/**
 * Where the global bundle is served from. Under `/@` because that is vite's
 * reserved namespace for things that are not files in your project, and a
 * plugin's middleware is installed before vite's own — so this path is ours
 * before anything tries to resolve it as a module.
 */
export const GLOBAL_SCRIPT_ROUTE = "/@fixui/fixui.global.js";

/** The marker attribute, and the answer to "has this document got one already?" */
const MARKER = "data-fixui";

export function fixui(options: FixUiViteOptions = {}): FixUiVitePlugin {
  let root: string | undefined;
  let discovery: Discovery | undefined;
  let looked = false;

  /** Read the discovery file once per dev server. `configureServer` normally
   *  gets here first; `transformIndexHtml` covers the case where it did not
   *  (an unrecognized server object, or a direct call from a test). */
  async function lookUp(): Promise<void> {
    if (looked) return;
    looked = true;
    const from = root ?? safeCwd();
    discovery = await findDiscovery(from);
    if (discovery === undefined) console.info(noBridgeNotice(from));
  }

  return {
    name: "fixui",
    // Serve only. There is no build-time half of this plugin, and a production
    // bundle must never be able to carry the picker or the review token.
    apply: "serve",

    async configureServer(server: unknown): Promise<void> {
      root = viteRoot(server);
      mount(server);
      await lookUp();
    },

    transformIndexHtml: {
      // After vite's own html handling, so the tag lands at the end of <body>
      // and the picker initializes against a document the app has finished
      // describing.
      order: "post",
      async handler(html: string): Promise<HtmlTag[]> {
        await lookUp();
        // Injected once. A second tag would mean two pickers, two review
        // channels and two chips on one page.
        if (html.includes(MARKER)) return [];
        return [
          {
            tag: "script",
            attrs: {
              src: GLOBAL_SCRIPT_ROUTE,
              [MARKER]: "",
              ...(discovery === undefined
                ? {}
                : { "data-port": String(discovery.port), "data-token": discovery.token }),
              ...(options.label === undefined ? {} : { "data-label": options.label }),
            },
            injectTo: "body",
          },
        ];
      },
    },
  };
}

/** The project directory vite was pointed at, if this really is a vite server. */
function viteRoot(server: unknown): string | undefined {
  try {
    const config = (server as { config?: { root?: unknown } } | null)?.config;
    return typeof config?.root === "string" ? config.root : undefined;
  } catch {
    return undefined;
  }
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

/** Serve `dist/fixui.global.js` off this package. Never throws: a dev server
 *  that dies because a dev tool could not find its own bundle is a worse
 *  outcome than a page without a picker. */
function mount(server: unknown): void {
  try {
    const use = (server as { middlewares?: { use?: unknown } } | null)?.middlewares?.use;
    if (typeof use !== "function") return;
    (use as (route: string, handler: MiddlewareHandler) => void).call(
      (server as { middlewares: unknown }).middlewares,
      GLOBAL_SCRIPT_ROUTE,
      serveGlobalScript,
    );
  } catch {
    // An object shaped like a vite server but not one. Nothing to serve from.
  }
}

const serveGlobalScript: MiddlewareHandler = async (_req, res) => {
  const body = await globalScript();
  try {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    // The bundle is regenerated by a build, and dev caching a stale picker is a
    // confusing hour for whoever hits it.
    res.setHeader("Cache-Control", "no-cache");
    res.end(body);
  } catch {
    try {
      res.end();
    } catch {
      // The response is gone. So is anything we could do about it.
    }
  }
};

/**
 * The built IIFE, or a script that explains its own absence in the page's
 * console. Answering 404 would surface as a bare network error with no clue
 * about which of the two situations you are in.
 */
async function globalScript(): Promise<string> {
  try {
    return await readFile(new URL("../dist/fixui.global.js", import.meta.url), "utf8");
  } catch {
    return `console.error(${JSON.stringify(
      "[fix-ui] dist/fixui.global.js is missing from @hulbu/fixui. Reinstall the package, or " +
        "run its build script if you are working from a checkout.",
    )});\n`;
  }
}
