// fixture 模块 example（blueprint §9 M2 验收装置）：activate → 命令 → 钩子 veto 全链路。
// 覆盖面：命令注册与分发、api.commit（所有权执法点）、before-commit 结构化否决、
// after-commit 排队追加、form 注册、目录外行为（M5 warning 演示）、所有权越界演示。
let activations = 0;

export default {
  // 供 S2 测试直读：每次 ModuleHost.load 恰好 +1（activate 恰好一次）
  get activations() {
    return activations;
  },

  activate(api) {
    activations += 1;

    // 全局命令（无 target）：创建 example.card（匿名 id 由 daemon 生成并回显）
    api.command(
      {
        name: "create-card",
        title: "创建 example.card 示例卡片；input.title 作显示名",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "卡片显示名" },
            poison: { type: "boolean", description: "true 触发本模块钩子否决" },
          },
        },
      },
      (ctx) => {
        // 有意不做类型矫正：schema 是说明书不是门禁，载荷原样入库（core 不解释）
        const payload = { title: ctx.input.title ?? "Example card" };
        if (ctx.input.poison === true) payload.poison = true;
        const r = api.commit({
          changes: [{ op: "put", kind: "example.card", payload }],
          label: "example.create-card",
        });
        return {
          message: `created ${r.created[0] ?? "?"} @ rev ${r.revision}`,
          data: { id: r.created[0] ?? null, revision: r.revision },
        };
      },
    );

    // 目录外行为（M5）：写入未声明的主类型 example.scribble —— 提交成功 + 记 warning
    api.command(
      { name: "scribble", title: "写入未声明主类型 example.scribble（声明词汇偏差演示）" },
      () => {
        const r = api.commit({
          changes: [{ op: "put", kind: "example.scribble", payload: { note: "undeclared" } }],
          label: "example.scribble",
        });
        return { message: `scribbled @ rev ${r.revision}` };
      },
    );

    // 所有权越界演示：触碰他人命名空间 → OWNERSHIP_VIOLATION（core 执法）
    api.command(
      { name: "steal", title: "尝试写入 wf.task（所有权法演示，必被拒）" },
      () => {
        api.commit({
          changes: [{ op: "put", kind: "wf.task", id: "stolen", payload: {} }],
          label: "example.steal",
        });
        return { message: "unreachable" };
      },
    );

    // before-commit 钩子：结构化否决 poison 载荷（details.vetoes[] 形状）
    api.hook("before-commit", (c) => {
      for (const ch of c.changes) {
        if (ch.op === "put" && ch.payload && ch.payload.poison === true) {
          return {
            veto: "example 模块拒绝 poison 载荷",
            details: { module: "example", kind: ch.kind ?? null },
          };
        }
      }
    });

    // after-commit 钩子：给新卡片补 source 标记（排队追加语义的真实用户）
    api.hook("after-commit", (e) => {
      const added = e.patch.objects.added.filter(
        (o) => o.kind === "example.card" && o.payload.source === undefined,
      );
      if (added.length === 0) return;
      api.commit({
        changes: added.map((o) => ({
          op: "merge",
          id: o.id,
          payload: { source: "example-module" },
        })),
        label: "example stamp",
      });
    });

    // WebUI inspector 载荷表单（M3 读；M2 注册即合法）
    api.form("example.card", {
      fields: [
        { name: "title", title: "标题", type: "string", required: true },
        { name: "pinned", type: "boolean" },
      ],
    });
  },
};
