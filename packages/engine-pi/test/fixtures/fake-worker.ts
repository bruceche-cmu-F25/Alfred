/** Speaks the worker protocol with a scripted "model", for testing the pool.
 * The goal decides what it does:
 *   tool <name> <json>   call that tool, then reply with its result
 *   crash                exit mid-run
 *   hang                 never answer, but stop when aborted
 *   stubborn             never answer, and ignore aborts
 *   who                  reply with the thread and whether history came along
 *   anything else        reply "echo: <goal>"
 */
import type { ToParent, ToWorker } from "../../src/protocol.ts";

const send = (message: ToParent) => process.send?.(message);
const waiting = new Map<string, (text: string) => void>();
let calls = 0;

process.on("message", async (message: ToWorker) => {
  if (message.type === "tool_result") {
    waiting.get(message.call)?.(message.ok ? message.text : `error: ${message.error}`);
    waiting.delete(message.call);
    return;
  }
  if (message.type === "abort") {
    if (process.argv.includes("--stubborn-seen")) return;
    send({ type: "error", run: message.run, message: "aborted", code: "AbortError" });
    return;
  }
  const { run, job } = message;
  const goal = job.prompt.split("\n\n").at(-1)!;
  send({ type: "text", run, text: "thinking" });
  if (goal.startsWith("tool ")) {
    const [, name, json] = goal.match(/^tool (\S+) (.*)$/)!;
    const call = String(++calls);
    const text = await new Promise<string>((resolve) => { waiting.set(call, resolve); send({ type: "tool", run, call, name, params: JSON.parse(json) }); });
    send({ type: "done", run, reply: `tool said: ${text}` });
  } else if (goal === "crash") {
    process.exit(3);
  } else if (goal === "hang") {
    // waits for an abort
  } else if (goal === "stubborn") {
    process.argv.push("--stubborn-seen");
  } else if (goal === "who") {
    send({ type: "done", run, reply: `${job.thread} history=${job.history ? "yes" : "no"} pid=${process.pid}` });
  } else {
    send({ type: "done", run, reply: `echo: ${goal}` });
  }
});
process.on("disconnect", () => process.exit(0));
