import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixUi } from "./react.js";

const NS = "data-uifb";

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

let container: HTMLElement;
let root: Root;

function jsonFetch() {
  return vi.fn<typeof fetch>(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
}

async function render(ui: ReactNode): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

function chip(): Element | null {
  return document.querySelector(`[${NS}-chip]`);
}

beforeEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  // The picker hydrates from the inbox on init — keep that off the network.
  vi.stubGlobal("fetch", jsonFetch());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await unmount();
  container.remove();
  document.body.innerHTML = "";
  document.body.style.cursor = "";
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("<FixUi />", () => {
  it("renders nothing and never initializes in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await render(<FixUi />);

    expect(container.innerHTML).toBe("");
    expect(chip()).toBeNull();
  });

  it("initializes on mount in a dev build and tears the picker down on unmount", async () => {
    await render(<FixUi />);
    expect(chip()).not.toBeNull();

    await unmount();

    expect(chip()).toBeNull();
    expect(document.querySelector(`[${NS}-box]`)).toBeNull();
  });

  it("passes its props through to the picker", async () => {
    await render(<FixUi chip={false} />);

    expect(chip()).toBeNull();
    expect(document.querySelector(`[${NS}-box]`)).not.toBeNull(); // picker is up, just chip-less
  });

  it("does not throw where there is no `process` at all (a bundler-less browser)", async () => {
    vi.stubGlobal("process", undefined);

    // Reading NODE_ENV throws here — nothing replaced the text and there is no
    // `process` — and the guard's catch treats that as dev, so the picker mounts
    // instead of the render blowing up.
    await render(<FixUi />);

    expect(chip()).not.toBeNull();
  });
});
