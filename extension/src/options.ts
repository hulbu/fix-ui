import {
  DEFAULT_BRIDGE_URL,
  OPTIONS_KEY,
  normalizeBridgeUrl,
  parseOriginMap,
  type StoredOptions,
} from "./protocol";

/**
 * The options page: where the bridge lives, and which project each origin's
 * notes belong to. Thin on purpose — parsing, validation and normalisation all
 * live in protocol.ts, which is the part that is unit-tested.
 */
const form = document.getElementById("options") as HTMLFormElement;
const bridgeInput = document.getElementById("bridge") as HTMLInputElement;
const projectsInput = document.getElementById("projects") as HTMLTextAreaElement;
const status = document.getElementById("status") as HTMLParagraphElement;

function say(message: string, tone: "ok" | "error" = "ok"): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

async function load(): Promise<void> {
  let stored: Partial<StoredOptions> | undefined;
  try {
    stored = (await chrome.storage.sync.get(OPTIONS_KEY))[OPTIONS_KEY] as
      | Partial<StoredOptions>
      | undefined;
  } catch {
    say("Could not read your settings — showing the defaults.", "error");
  }
  bridgeInput.value = typeof stored?.bridgeUrl === "string" ? stored.bridgeUrl : DEFAULT_BRIDGE_URL;
  projectsInput.value = typeof stored?.originMap === "string" ? stored.originMap : "";
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const bridgeUrl = normalizeBridgeUrl(bridgeInput.value);
  if (bridgeUrl === null) {
    say(
      `${bridgeInput.value.trim()} is not a loopback http URL — use ${DEFAULT_BRIDGE_URL} or another http://127.0.0.1 / http://localhost address.`,
      "error",
    );
    return;
  }
  bridgeInput.value = bridgeUrl;

  // The raw text is what gets stored (comments and all); bad lines are reported
  // rather than deleted, so a typo never quietly loses a mapping.
  const originMap = projectsInput.value;
  const { mappings, errors } = parseOriginMap(originMap);

  const options: StoredOptions = { bridgeUrl, originMap };
  try {
    await chrome.storage.sync.set({ [OPTIONS_KEY]: options });
  } catch (error) {
    say(`Could not save: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const saved = `Saved. ${mappings.length} ${mappings.length === 1 ? "origin is" : "origins are"} mapped to a project.`;
  if (errors.length === 0) {
    say(`${saved} Changes apply the next time you switch fix-ui on for a tab.`);
    return;
  }
  say(
    [`${saved} These lines are ignored:`, ...errors.map((e) => `  line ${e.line}: ${e.reason}`)].join(
      "\n",
    ),
    "error",
  );
}

form.addEventListener("submit", (event) => void save(event));
void load();
