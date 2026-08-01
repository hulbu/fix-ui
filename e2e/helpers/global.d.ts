import type { Picker } from "@hulbu/fixui";

declare global {
  interface Window {
    /** What the fixture pages hang `initFixUi()` on (see fixtures/*.html). */
    fixui: Picker & { close(): void };
  }
}

export {};
