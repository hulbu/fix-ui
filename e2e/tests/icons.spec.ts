import {
  BADGE,
  CHIP,
  COPY,
  DEL,
  GLYPH,
  GRIP,
  HEAD,
  MARK,
  MINIMIZE,
  PANEL,
  PICK,
  TOAST,
  expect,
  openFixture,
  pickAndNote,
  test,
} from "../helpers/fixui";

/**
 * The assertion that would have caught both reports before the author did.
 *
 * A unit test can prove a rule says `display:flex`. It cannot prove the thing
 * inside the box ended up in the middle of it — that depends on the glyph's own
 * metrics, on the font the platform resolved `system-ui` to, and on whatever
 * the host page's CSS cascades into a control the picker mounted into its DOM.
 * All three of those are browser facts, so all three are measured here: for
 * every control, where the mark's ink actually lands against the box drawing
 * it, in pixels.
 *
 * The fixture is deliberately the hostile one: `basic.html` styles `button`
 * with its own padding, which is exactly what turned the 22px delete disc into
 * a 28x22 oval with the cross pushed out of it.
 */

/** Ink and box alike, once the measuring is done. */
interface Edges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Gaps extends Edges {
  width: number;
  height: number;
}

/**
 * The gap on each side is what "centred" is a claim about: matching left and
 * right means the mark sits in the middle horizontally, whatever its size.
 *
 * A quarter pixel, not the whole one the brief allows: every mark below is
 * drawn symmetric about its own viewBox and centred by a flex box, so the
 * honest expectation is zero, and every gap measured here matches to about
 * 1e-7 — except the chip's typeset glyph, which lands one Chromium layout unit
 * (1/64px = 0.0156) out because its advance width is fractional. That leaves
 * more than an order of magnitude of headroom while still being tight enough
 * to fail on the real defects: a whole pixel of slack would have let the
 * chevron's own 0.5px asymmetry through, which is how it got here.
 */
const TOLERANCE = 0.25;

function expectCentred(gaps: Gaps, axis: "both" | "vertical" = "both"): void {
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThanOrEqual(TOLERANCE);
  if (axis === "both") expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(TOLERANCE);
  // A mark centred by having no room to be off-centre would prove nothing.
  expect(gaps.top).toBeGreaterThan(0);
  if (axis === "both") expect(gaps.left).toBeGreaterThan(0);
}

test("every mark sits dead centre in the control that draws it", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  // One saved note, so the panel has a row (and therefore a delete button) and
  // the chip has a count on it.
  await page.locator(CHIP).click();
  await page.locator(PICK).click();
  await pickAndNote(page, "#save-btn", "a note, so there is a row to delete");
  // The picker is still armed after a save — that is the point of it — so the
  // first click stands it down and the second opens the notes panel. Two
  // clicks, deterministically: the armed state is now something the suite
  // asserts rather than something it works around.
  await page.locator(CHIP).click();
  await expect(page.locator(PANEL)).toHaveCount(0);
  await page.locator(CHIP).click();
  await expect(page.locator(PANEL)).toHaveCount(1);
  await expect(page.locator(DEL)).toHaveCount(1);
  await expect(page.locator(COPY)).toHaveCount(1);

  const measured = await page.evaluate(() => {
    function edges(rect: DOMRect): Edges {
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }

    /**
     * Where a drawn mark's ink actually lands, in client pixels.
     *
     * `getBBox()` is the GEOMETRY box — the path's own points, with no stroke.
     * SVG 2's `getBBox({stroke:true})` is not implemented in Chromium (it
     * silently returns the same rect), so the round cap's half stroke width is
     * added here, which is what the browser paints out to.
     */
    function inkOf(svg: SVGSVGElement): Edges {
      const box = svg.getBoundingClientRect();
      const [vx, vy, vw] = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const scale = box.width / vw!;
      const paths = [...svg.querySelectorAll("path")];
      const half = Number(paths[0]!.getAttribute("stroke-width")) / 2;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const path of paths) {
        const b = path.getBBox();
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.width);
        y1 = Math.max(y1, b.y + b.height);
      }
      return {
        left: box.left + (x0 - half - vx!) * scale,
        right: box.left + (x1 + half - vx!) * scale,
        top: box.top + (y0 - half - vy!) * scale,
        bottom: box.top + (y1 + half - vy!) * scale,
      };
    }

    function gapsOf(inner: Edges, outer: Edges): Gaps {
      return {
        left: inner.left - outer.left,
        right: outer.right - inner.right,
        top: inner.top - outer.top,
        bottom: outer.bottom - inner.bottom,
        width: outer.right - outer.left,
        height: outer.bottom - outer.top,
      };
    }

    const at = (selector: string) => document.querySelector(selector)!;
    const markIn = (selector: string) => at(selector).querySelector("svg")! as SVGSVGElement;

    /**
     * Is this control actually clickable where it is drawn?
     *
     * Centring is half the claim; the other half is that the pixel in the
     * middle of the box belongs to this control and not to its neighbour, to
     * the row, or to a popover layered over the top. `elementFromPoint`
     * respects the top layer, which is where the panel lives, so this is the
     * browser's own hit test rather than an arithmetic re-derivation of it.
     */
    function hitTest(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return hit !== null && el.contains(hit);
    }

    const del = at("[data-uifb-del]");
    const copy = at("[data-uifb-copy]");
    const min = at("[data-uifb-min]");
    const pick = at("[data-uifb-pick]");
    const chip = at("[data-uifb-chip]");
    const grip = at("[data-uifb-grip]");
    const gripStyle = getComputedStyle(grip);

    return {
      // The reported bug: a drawn cross in a 22px disc.
      del: gapsOf(inkOf(markIn("[data-uifb-del]")), edges(del.getBoundingClientRect())),
      delInOwnBox: gapsOf(
        inkOf(markIn("[data-uifb-del]")),
        edges(markIn("[data-uifb-del]").getBoundingClientRect()),
      ),
      // …and the control that just moved in next door, held to the same claim.
      copy: gapsOf(inkOf(markIn("[data-uifb-copy]")), edges(copy.getBoundingClientRect())),
      copyInOwnBox: gapsOf(
        inkOf(markIn("[data-uifb-copy]")),
        edges(markIn("[data-uifb-copy]").getBoundingClientRect()),
      ),
      // Two small targets side by side: each one clickable in its own middle,
      // and separated by the 4px the sheet declares rather than overlapping.
      pair: {
        copyHit: hitTest(copy),
        delHit: hitTest(del),
        gap: del.getBoundingClientRect().left - copy.getBoundingClientRect().right,
        // Copy comes first — the destructive control is not on the way to it.
        copyBeforeDel: copy.getBoundingClientRect().left < del.getBoundingClientRect().left,
        // …and the pair sits inside the row, not spilling out of it.
        insideRow:
          copy.getBoundingClientRect().left >= at("[data-uifb-row]").getBoundingClientRect().left &&
          del.getBoundingClientRect().right <=
            at("[data-uifb-row]").getBoundingClientRect().right + 0.5,
      },
      // The minimize chevron, in its 20px box.
      min: gapsOf(inkOf(markIn("[data-uifb-min]")), edges(min.getBoundingClientRect())),
      minInOwnBox: gapsOf(
        inkOf(markIn("[data-uifb-min]")),
        edges(markIn("[data-uifb-min]").getBoundingClientRect()),
      ),
      // The Pick button is a ROW: its mark is centred against the label
      // vertically, and shares the row's own centring horizontally.
      pick: gapsOf(inkOf(markIn("[data-uifb-pick]")), edges(pick.getBoundingClientRect())),
      pickInOwnBox: gapsOf(
        inkOf(markIn("[data-uifb-pick]")),
        edges(markIn("[data-uifb-pick]").getBoundingClientRect()),
      ),
      // The chip's ✛ is typeset, not drawn — it is the product's mark. Its INK
      // is at the mercy of whatever font the platform resolved, so what layout
      // can actually guarantee, and what is asserted, is that the glyph's BOX
      // is centred. (This is why every other mark here is a path instead.)
      chip: gapsOf(
        edges(at("[data-uifb-glyph]").getBoundingClientRect()),
        edges(chip.getBoundingClientRect()),
      ),
      sizes: {
        del: [del.getBoundingClientRect().width, del.getBoundingClientRect().height],
        copy: [copy.getBoundingClientRect().width, copy.getBoundingClientRect().height],
        min: [min.getBoundingClientRect().width, min.getBoundingClientRect().height],
        chip: [chip.getBoundingClientRect().width, chip.getBoundingClientRect().height],
        badge: [
          at("[data-uifb-badge]").getBoundingClientRect().width,
          at("[data-uifb-badge]").getBoundingClientRect().height,
        ],
      },
      // The grip is a tiled background rather than an element, so "centred" is
      // a different claim: the box is a whole number of tiles, which puts the
      // dots symmetrically inside it. Plus the row centres the box itself.
      gripBox: grip.getBoundingClientRect().width,
      gripHeight: grip.getBoundingClientRect().height,
      gripTile: gripStyle.backgroundSize,
      gripOrigin: gripStyle.backgroundPosition,
      gripInHead: gapsOf(
        edges(grip.getBoundingClientRect()),
        edges(at("[data-uifb-head]").getBoundingClientRect()),
      ),
      marks: document.querySelectorAll("[data-uifb-mark]").length,
    };
  });

  // --- the reported control -------------------------------------------------
  // Square, not the 28x22 oval the host page's `button{padding:6px 14px}` used
  // to make of it: this is `box-sizing:border-box` plus `padding:0` holding.
  // And no narrower than that oval was — the declared size went 22 -> 24 so
  // that pinning the box down could not cost the target any width.
  expect(measured.sizes.del).toEqual([24, 24]);
  expectCentred(measured.del);
  expectCentred(measured.delInOwnBox);

  // --- the control that moved in beside it ----------------------------------
  // Same square, from the same constant in the sheet — on the same hostile
  // fixture, whose `button{padding:6px 14px}` is what deformed the first one.
  expect(measured.sizes.copy).toEqual([24, 24]);
  expectCentred(measured.copy);
  expectCentred(measured.copyInOwnBox);

  // Centred is not enough for a 24px target with a neighbour: each has to be
  // the thing the browser actually hits in its own middle, and they must not
  // be sitting on top of each other to manage it.
  expect(measured.pair.copyHit).toBe(true);
  expect(measured.pair.delHit).toBe(true);
  expect(measured.pair.gap).toBeCloseTo(4, 1);
  expect(measured.pair.copyBeforeDel).toBe(true);
  expect(measured.pair.insideRow).toBe(true);

  // --- the rest of the audit ------------------------------------------------
  expect(measured.sizes.min).toEqual([20, 20]);
  expectCentred(measured.min);
  expectCentred(measured.minInOwnBox);

  // A row, so only the vertical claim is "centred in the control" — but the
  // mark is still symmetric inside its own box on both axes.
  expectCentred(measured.pick, "vertical");
  expectCentred(measured.pickInOwnBox);

  // The chip, unchanged and now guarded: its glyph box is centred in the disc.
  expect(measured.sizes.chip).toEqual([44, 44]);
  expectCentred(measured.chip);

  // The count is a disc, not the 27x19 oval `min-width` under content-box made
  // of it — a single digit is as round as the chip it sits on.
  expect(measured.sizes.badge).toEqual([19, 19]);

  // The grip: 2 tiles across, 3 down, tiled from the origin, so the dots are
  // symmetric within it — and the header centres the box.
  expect(measured.gripTile).toBe("4px 4px");
  expect(measured.gripOrigin).toBe("0px 0px");
  expect(measured.gripBox % 4).toBe(0);
  expect(measured.gripHeight % 4).toBe(0);
  expect(Math.abs(measured.gripInHead.top - measured.gripInHead.bottom)).toBeLessThanOrEqual(
    TOLERANCE,
  );

  // Every mark on screen is one the picker drew: the copy sheets, the delete
  // cross, the chevron and the Pick button's cross. No glyphs, no emoji.
  expect(measured.marks).toBe(4);
});

/**
 * The copy control doing its job in a real browser, where the clipboard is a
 * permission and not a stub.
 *
 * Chromium hands a Playwright context clipboard-write without a prompt, so the
 * write is the real `navigator.clipboard.writeText` — and the read-back below
 * is what proves the button copied the note rather than merely toasting.
 */
test("copying a note puts the element and the note on the clipboard", async ({
  page,
  baseURL,
  bridge,
}) => {
  // Reading it back is what makes this an assertion rather than a toast check,
  // and reading the clipboard is a permission the browser has to be asked for.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL!,
  });
  await openFixture(page, baseURL!, "basic.html", bridge);

  await page.locator(CHIP).click();
  await page.locator(PICK).click();
  await pickAndNote(page, "#save-btn", "Primary button should be brand blue");
  await page.locator(CHIP).click(); // armed → stand down
  await page.locator(CHIP).click(); // → open the panel

  await page.locator(COPY).click();
  await expect(page.locator(TOAST).filter({ hasText: "Copied" }).last()).toBeVisible();

  // WHERE, then WHAT — one line, which is what gets pasted at an agent.
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("#save-btn — Primary button should be brand blue");

  // The delete control beside it still does its own job, unmoved by the
  // neighbour: the row goes, and the note goes with it.
  await page.locator(DEL).click();
  await expect(page.locator(DEL)).toHaveCount(0);
  await expect.poll(async () => (await bridge.entries()).length).toBe(0);
});

test("a minimized panel still centres the mark it has left", async ({ page, baseURL, bridge }) => {
  await openFixture(page, baseURL!, "basic.html", bridge);
  await page.locator(CHIP).click();
  await expect(page.locator(PANEL)).toHaveCount(1);

  // Folding the panel rotates the chevron rather than swapping the mark — and
  // a rotated mark is only still centred if it was symmetric to begin with.
  await page.locator(MINIMIZE).click();
  await expect(page.locator(PICK)).toHaveCount(0);

  const gaps = await page.evaluate(() => {
    const min = document.querySelector("[data-uifb-min]")!;
    const svg = min.querySelector("svg")! as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    const outer = min.getBoundingClientRect();
    const [vx, vy, vw] = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
    const scale = box.width / vw!;
    const path = svg.querySelector("path")!;
    const half = Number(path.getAttribute("stroke-width")) / 2;
    const b = path.getBBox();
    // The rotation is about the box's own centre, so the ink is measured
    // through the box rather than from the untransformed path data.
    const ink = {
      left: box.left + (b.x - half - vx!) * scale,
      right: box.left + (b.x + b.width + half - vx!) * scale,
      top: box.top + (b.y - half - vy!) * scale,
      bottom: box.top + (b.y + b.height + half - vy!) * scale,
    };
    return {
      left: ink.left - outer.left,
      right: outer.right - ink.right,
      top: ink.top - outer.top,
      bottom: outer.bottom - ink.bottom,
    };
  });

  expect(Math.abs(gaps.left - gaps.right)).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThanOrEqual(TOLERANCE);

  // The grip and the count survive the fold — the header is all there is.
  await expect(page.locator(GRIP)).toHaveCount(1);
  await expect(page.locator(HEAD)).toHaveCount(1);
  await expect(page.locator(MARK)).toHaveCount(1);
  await expect(page.locator(GLYPH)).toHaveCount(1);
  await expect(page.locator(BADGE)).toHaveCount(0); // nothing saved in this test
});
