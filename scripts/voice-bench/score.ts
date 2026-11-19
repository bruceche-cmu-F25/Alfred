/** Scoring for mixed Chinese/English transcripts.
 *
 * Mixed error rate (MER): each Chinese character is one token, each run of Latin letters/digits is one token;
 * edit distance over those tokens divided by the reference's token count. Punctuation, spacing and case are ignored,
 * and simple Chinese numerals are turned into digits on both sides, so "三点" and "3点" count as the same.
 */

const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "十五" → 15, "二十" → 20, "三百零五" → 305, "一" → 1. Anything odder is left alone. */
function chineseNumber(run: string): string {
  if (!/[十百]/.test(run)) return [...run].map((ch) => DIGITS[ch]).join("");
  let total = 0, current = 0;
  for (const ch of run) {
    if (ch in DIGITS) current = DIGITS[ch];
    else if (ch === "十") { total += (current || 1) * 10; current = 0; }
    else if (ch === "百") { total += (current || 1) * 100; current = 0; }
  }
  return String(total + current);
}

export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[零〇一二两三四五六七八九十百]+/g, chineseNumber)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Hesitation sounds: some engines write them, some drop them, and dictation should drop them. Not scored. */
const FILLERS = new Set(["呃", "嗯", "额", "um", "uh", "er", "erm", "hmm", "mm", "eh"]);

export function tokens(text: string): string[] {
  // Han first and one at a time; the other run must not swallow Han characters that follow a digit ("3点").
  return (normalize(text).match(/\p{Script=Han}|[\p{Script=Latin}\p{N}]+/gu) ?? []).filter((t) => !FILLERS.has(t));
}

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export interface Score { errors: number; refTokens: number; termsHit: number; termsTotal: number; missed: string[] }

/** A term counts as heard when its letters and digits appear in the transcript in order, ignoring spaces,
 * punctuation and case: "useSpeech" matches "use speech", "pool.ts" matches "pool ts". */
const squash = (text: string) => normalize(text).replace(/\s+/g, "");

export function score(ref: string, hyp: string, terms: string[]): Score {
  const r = tokens(ref), h = tokens(hyp);
  const heard = squash(hyp);
  const missed = terms.filter((term) => !heard.includes(squash(term)));
  return { errors: editDistance(r, h), refTokens: r.length, termsHit: terms.length - missed.length, termsTotal: terms.length, missed };
}
