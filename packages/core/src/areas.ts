/** Areas: the parts of life things belong to. A shared kernel for every module that sorts things this way (todos,
 * and later the calendar), so "工作" means the same area everywhere and keeps the same colour.
 *
 * Fixed for now: seven, each with a colour slot whose order was checked for colour-blind separation (tokens.css).
 * Things store the id, so a name can change without touching them.
 */
export interface Area {
  id: string;
  name: string;
  /** Colour slot in tokens.css (`data-k`). */
  k: string;
}

export const AREAS: readonly Area[] = Object.freeze([
  { id: "work", name: "工作", k: "blue" },
  { id: "life", name: "生活", k: "green" },
  { id: "learn", name: "学习", k: "violet" },
  { id: "travel", name: "出行", k: "orange" },
  { id: "health", name: "健康", k: "teal" },
  { id: "money", name: "财务", k: "yellow" },
  { id: "people", name: "家人朋友", k: "pink" },
]);

export const AREA_IDS: readonly string[] = AREAS.map((area) => area.id);

export function isArea(id: string): boolean {
  return AREA_IDS.includes(id);
}

export function areaName(id: string | undefined): string | undefined {
  return AREAS.find((area) => area.id === id)?.name;
}
