import { beforeEach, describe, expect, it } from "vitest";

import { buildSelector, getReactComponentName } from "./dom.js";

describe("buildSelector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("prefers an id when the element has one", () => {
    document.body.innerHTML = `<div><button id="cta">Go</button></div>`;
    const el = document.getElementById("cta")!;
    expect(buildSelector(el)).toBe("#cta");
  });

  it("uses the nearest ancestor id as the anchor", () => {
    document.body.innerHTML = `
      <section id="hero"><div><p>one</p><p>two</p></div></section>`;
    const el = document.querySelectorAll("p")[1]!;
    const selector = buildSelector(el);
    expect(selector.startsWith("#hero")).toBe(true);
    expect(document.querySelector(selector)).toBe(el);
  });

  it("disambiguates siblings with nth-of-type and resolves uniquely", () => {
    document.body.innerHTML = `
      <ul><li class="item">a</li><li class="item">b</li><li class="item">c</li></ul>`;
    const el = document.querySelectorAll("li")[2]!;
    const selector = buildSelector(el);
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)).toBe(el);
  });

  it("skips utility classes containing special characters", () => {
    document.body.innerHTML = `<div><span class="sm:flex hover:bg-red-500 badge">x</span></div>`;
    const el = document.querySelector("span")!;
    const selector = buildSelector(el);
    expect(selector).toContain("span.badge");
    expect(document.querySelector(selector)).toBe(el);
  });
});

describe("getReactComponentName", () => {
  it("walks a fake fiber chain to the nearest named component", () => {
    document.body.innerHTML = `<div id="x"></div>`;
    const el = document.getElementById("x")! as unknown as Record<string, unknown>;
    function WaitlistForm() {}
    el["__reactFiber$abc123"] = {
      type: "div",
      return: { type: "span", return: { type: WaitlistForm, return: null } },
    };
    expect(getReactComponentName(el as unknown as Element)).toBe("WaitlistForm");
  });

  it("returns undefined for non-React elements", () => {
    document.body.innerHTML = `<div id="y"></div>`;
    expect(getReactComponentName(document.getElementById("y")!)).toBeUndefined();
  });
});
