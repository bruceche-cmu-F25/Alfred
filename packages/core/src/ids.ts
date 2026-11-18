import { randomBytes } from "node:crypto";

/** Short, URL-safe and random enough for a single user's world. */
export function newId(): string {
  return randomBytes(9).toString("base64url");
}

export const iso = (ms: number) => new Date(ms).toISOString();
