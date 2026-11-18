import type { AwayDigest } from "@alfred/protocol";

function duration(ms: number): string {
  if (ms < 60_000) return "一会儿";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)} 天`;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

/** The welcome, from the digest the home node recorded, never from guesses. */
export function welcomeLines(digest: AwayDigest, name: string | null): { greeting: string; summary: string } {
  const greeting = `欢迎回来${name ? `，${name}` : ""}。`;
  const away = `你离开了${duration(digest.awayMs).replace(/^(\d)/, " $1")}`;
  const parts: string[] = [];
  const { completed, failed, interrupted, goals } = digest.runs;
  if (completed) parts.push(completed === 1 && goals[0] ? `办完了「${goals[0]}」` : `办完了 ${completed} 件事`);
  if (failed) parts.push(`${failed} 件没办成`);
  if (interrupted) parts.push(`${interrupted} 件中断了`);
  if (!completed) {
    const todo = digest.changes.todo ?? 0;
    if (todo) parts.push(`改动了 ${todo} 条待办`);
  }
  if (digest.waiting) parts.push(`有 ${digest.waiting} 件等你看`);
  return { greeting, summary: parts.length ? `${away}：${parts.join("，")}。` : `${away}，这段时间没有新动静。` };
}
