/** The UI's side of the dictionary: everything in dict.ts, plus a hook that re-renders when the language changes. */
import { useSyncExternalStore } from "react";
import { getLocale, onLocale, type Locale } from "./dict.ts";

export * from "./dict.ts";

export function useLocale(): Locale {
  return useSyncExternalStore(onLocale, getLocale);
}
