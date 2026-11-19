/** The user's preferences that are not secrets, held by the home node so every device and everything the node says
 * itself (a proposal's steps, a permission question) agree. Each change is a `settings.changed` event, audited like
 * any other change (docs/design/settings-and-connections.md §3.5). The first field is the language.
 */
import type { DatabaseSync } from "node:sqlite";
import { recordDomainEvent } from "./events.ts";
import { iso } from "./ids.ts";
import type { World } from "./world.ts";

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export interface UserSettings {
  /** The language Alfred speaks on every device. Null until a device sets it from its system language. */
  locale: Locale | null;
}

export class SettingsError extends Error {
  override name = "SettingsError";
}

const DEFAULTS: UserSettings = { locale: null };

export function getSettings(world: World): UserSettings {
  const rows = world.db.prepare("SELECT key, value FROM core_settings").all();
  const stored = Object.fromEntries(rows.map((row) => [row.key as string, JSON.parse(row.value as string)]));
  return { ...DEFAULTS, ...pick(stored) };
}

/** The language for text the node writes itself; English until the user's devices have said otherwise. */
export function userLocale(world: World): Locale {
  return localeOf(world.db);
}

/** The same, inside a transaction that has only the database. */
export function localeOf(db: DatabaseSync): Locale {
  const row = db.prepare("SELECT value FROM core_settings WHERE key = 'locale'").get();
  const locale = row ? JSON.parse(row.value as string) as unknown : null;
  return LOCALES.includes(locale as Locale) ? locale as Locale : "en";
}

function pick(value: Record<string, unknown>): Partial<UserSettings> {
  const out: Partial<UserSettings> = {};
  if ("locale" in value) {
    if (value.locale !== null && !LOCALES.includes(value.locale as Locale)) throw new SettingsError(`locale must be one of: ${LOCALES.join(", ")}`);
    out.locale = value.locale as Locale | null;
  }
  return out;
}

export function updateSettings(world: World, patch: Record<string, unknown>, now: number = Date.now()): UserSettings {
  const unknown = Object.keys(patch).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new SettingsError(`Unknown setting: ${unknown.join(", ")}`);
  const changes = pick(patch);
  return world.tx((db) => {
    const before = getSettings(world);
    const changed: Record<string, [unknown, unknown]> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (JSON.stringify(before[key as keyof UserSettings]) === JSON.stringify(value)) continue;
      db.prepare("INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .run(key, JSON.stringify(value), iso(now));
      changed[key] = [before[key as keyof UserSettings], value];
    }
    if (Object.keys(changed).length) recordDomainEvent(world, { kind: "settings.changed", subject: "settings", payload: { changes: changed }, now });
    return getSettings(world);
  });
}
