/**
 * Build a short, stable CSS selector for an element: nearest id anchors the
 * path, utility classes with special characters (Tailwind variants) are
 * skipped, nth-of-type disambiguates siblings. Returns the shortest prefix
 * that uniquely resolves in the current document.
 */
function cssEscape(value: string): string {
  const impl = globalThis.CSS?.escape;
  if (typeof impl === "function") return impl(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function partFor(node: Element): string {
  let part = node.tagName.toLowerCase();
  const classes = [...node.classList]
    .filter((c) => !/[^a-zA-Z0-9_-]/.test(c) && !/^\d/.test(c))
    .slice(0, 2);
  if (classes.length > 0) {
    part += "." + classes.map((c) => cssEscape(c)).join(".");
  }
  const parent = node.parentElement;
  if (parent) {
    const sameTag = [...parent.children].filter(
      (s) => s.tagName === node.tagName,
    );
    if (sameTag.length > 1) {
      part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
  }
  return part;
}

function matchesUniquely(selector: string, el: Element): boolean {
  try {
    return (
      document.querySelectorAll(selector).length === 1 &&
      document.querySelector(selector) === el
    );
  } catch {
    return false;
  }
}

export function buildSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`;

  // Walk up to the nearest id anchor (or the document root), collecting a
  // structural path.
  const parts: string[] = [];
  let anchor: string | null = null;
  let node: Element | null = el;
  while (node && node !== document.documentElement && parts.length < 8) {
    if (node !== el && node.id) {
      anchor = `#${cssEscape(node.id)}`;
      break;
    }
    parts.unshift(partFor(node));
    node = node.parentElement;
  }

  // Prefer the shortest suffix of the path — always keeping the id anchor
  // when one exists, since anchored selectors survive page changes better.
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const suffix = parts.slice(i).join(" > ");
    const candidate = anchor ? `${anchor} ${suffix}` : suffix;
    if (matchesUniquely(candidate, el)) return candidate;
  }

  return anchor ? `${anchor} ${parts.join(" > ")}` : parts.join(" > ");
}

/**
 * Best-effort React component name for a DOM node: find the fiber key React
 * attaches in dev builds and walk up until a named function/class component.
 */
export function getReactComponentName(el: Element): string | undefined {
  const record = el as unknown as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return undefined;

  type Fiberish = { type?: unknown; return?: Fiberish | null } | null;
  let fiber = record[key] as Fiberish;
  let hops = 0;
  while (fiber && hops < 50) {
    const t = fiber.type;
    if (typeof t === "function" && t.name) return t.name;
    if (
      typeof t === "object" &&
      t !== null &&
      "render" in t &&
      typeof (t as { render: unknown }).render === "function"
    ) {
      const render = (t as { render: { name?: string } }).render;
      if (render.name) return render.name;
    }
    fiber = fiber.return ?? null;
    hops += 1;
  }
  return undefined;
}
