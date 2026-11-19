/** Areas: the parts of life things belong to. A shared kernel for every module that sorts things this way (todos,
 * and later the calendar), so "工作" means the same area everywhere and keeps the same colour.
 *
 * Fixed for now: seven, each with a colour slot whose order was checked for colour-blind separation (tokens.css).
 * Things store the id, so a name can change without touching them.
 */
import type { Locale } from "./settings.ts";

export interface Area {
  id: string;
  name: Record<Locale, string>;
  /** Colour slot in tokens.css (`data-k`). */
  k: string;
}

export const AREAS: readonly Area[] = Object.freeze([
  { id: "work", name: { zh: "工作", en: "Work" }, k: "blue" },
  { id: "life", name: { zh: "生活", en: "Life" }, k: "green" },
  { id: "learn", name: { zh: "学习", en: "Learning" }, k: "violet" },
  { id: "travel", name: { zh: "出行", en: "Travel" }, k: "orange" },
  { id: "health", name: { zh: "健康", en: "Health" }, k: "teal" },
  { id: "money", name: { zh: "财务", en: "Money" }, k: "yellow" },
  { id: "people", name: { zh: "家人朋友", en: "People" }, k: "pink" },
]);

export const AREA_IDS: readonly string[] = AREAS.map((area) => area.id);

export function isArea(id: string): boolean {
  return AREA_IDS.includes(id);
}

export function areaName(id: string | undefined, locale: Locale = "en"): string | undefined {
  return AREAS.find((area) => area.id === id)?.name[locale];
}
