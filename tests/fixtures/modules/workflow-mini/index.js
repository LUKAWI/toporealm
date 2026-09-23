// fixture 模块 workflow-mini（blueprint §9 M2 验收装置）：七态语义的最小切片——
// before-commit 钩子把关非法流转（对一切来源生效）+ target 命令（appliesTo 兑现）
// + requires 依赖 example（拓扑排序 / MISSING_MODULE 演示）。
// 注意：只把守形状（未知状态、pending 直跳 passed），不把守完整七态图——
// undo 需要能逆转已合法的流转；完整移植在 M5。
const KNOWN = [
  "pending",
  "ready",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
];
const KNOWN_SET = new Set(KNOWN);

let activations = 0;

function isIllegalTransition(from, to) {
  if (!KNOWN_SET.has(to)) return true; // 未知状态
  return from === "pending" && to === "passed"; // 非法流转演示
}

export default {
  // 供 S2 测试直读：每次 ModuleHost.load 恰好 +1（activate 恰好一次）
  get activations() {
    return activations;
  },

  activate(api) {
    activations += 1;
    // 领域钩子：任何来源（cli/module/external/undo）改 wf.task 的 status 都要过关
    api.hook("before-commit", (c) => {
      for (const ch of c.changes) {
        if (ch.op !== "put" && ch.op !== "merge") continue;
        const nextStatus =
          ch.payload && typeof ch.payload.status === "string"
            ? ch.payload.status
            : undefined;
        if (nextStatus === undefined) continue;
        const prev = c.before.objects.find((o) => o.id === ch.id);
        if (!prev || prev.kind !== "wf.task") continue; // 新建或非本模块类型不拦
        const from =
          typeof prev.payload.status === "string" ? prev.payload.status : "pending";
        if (isIllegalTransition(from, nextStatus)) {
          return {
            veto: `wf.task "${ch.id}" 不能从 ${from} 流转到 ${nextStatus}`,
            details: { module: "workflow-mini", id: ch.id, from, to: nextStatus },
          };
        }
      }
    });

    // target 命令：appliesTo = wf.task（target 存在性 + 主类型兑现由 host 分发面管）
    api.command(
      {
        name: "start",
        title: "开始任务：status → running",
        target: "wf.task",
        input: { type: "object" },
      },
      (ctx) => {
        api.commit({
          changes: [{ op: "merge", id: ctx.target.id, payload: { status: "running" } }],
          label: `wf.start ${ctx.target.id}`,
        });
        return { message: `started ${ctx.target.id}` };
      },
    );

    api.command(
      {
        name: "pass",
        title: "通过任务：status → passed（pending 直跳会被本模块钩子否决）",
        target: "wf.task",
      },
      (ctx) => {
        api.commit({
          changes: [{ op: "merge", id: ctx.target.id, payload: { status: "passed" } }],
          label: `wf.pass ${ctx.target.id}`,
        });
        return { message: `passed ${ctx.target.id}` };
      },
    );

    // 全局只读命令：无 target，读内存态直接作答
    api.command(
      { name: "next", title: "列出 pending 状态的 wf.task id（全局只读命令）" },
      () => {
        const tasks = api
          .byKind("wf.task")
          .filter((t) => (t.payload.status ?? "pending") === "pending")
          .map((t) => t.id);
        return { data: { tasks } };
      },
    );

    api.form("wf.task", {
      fields: [
        { name: "title", title: "标题", type: "string", required: true },
        { name: "status", type: "enum", options: KNOWN },
      ],
    });
  },
};
