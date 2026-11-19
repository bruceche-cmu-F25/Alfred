import type { CoreEvent } from "@alfred/protocol";

const FIELD: Record<string, string> = {
  title: "标题", due: "截止日", startDate: "开始日", plannedOn: "计划日", url: "链接", status: "状态", done: "完成",
};

/** One line per receipt, from what was recorded, not from the model's words. */
export function describeReceipt(event: CoreEvent): string {
  const title = typeof event.payload.title === "string" ? `「${event.payload.title}」` : "";
  switch (event.kind) {
    case "todo.added": return `添加了待办${title}`;
    case "todo.completed": return `完成了${title}`;
    case "todo.deleted": return `删除了${title}`;
    case "todo.updated": {
      const changes = Object.keys((event.payload.changes as Record<string, unknown> | undefined) ?? {});
      const fields = changes.map((field) => FIELD[field]).filter(Boolean);
      return `修改了${title}${fields.length ? `的${[...new Set(fields)].join("、")}` : ""}`;
    }
    case "todo.imported": return `导入了 ${String(event.payload.imported)} 条待办`;
    case "proposal.opened": return `提议：${title}，在通知里等你决定`;
    default: return event.kind;
  }
}

export const ERRORS: Record<string, string> = {
  engine_failed: "模型那边出错了。",
  engine_unavailable: "还没有可用的模型。先在 Pi 里登录一个模型提供方。",
  timeout: "等太久，停下了。",
  unknown_profile: "这个请求没有对应的能力档。",
  lease_lost: "执行权过期了，后面的改动没有写入。",
  engine_crashed: "模型进程意外退出了。已经做了的改动都在回执里，没有自动重做。",
};
