// ---------- 模块入口（代码层） ----------
//
// 双层模块：module.yaml 只管协调；行为全部在 activate 里注册。
// 注册面在 activate 返回后冻结——迟到注册得到 LATE_REGISTRATION。
//
// 自包含发布：对平台/其它包零运行时依赖。模块 SDK 只做 **类型导入**
// （emit 后擦除）——dist/ 可被 daemon 直接 import，无需 node_modules。
// 若用 defineModule()（运行时恒等函数），需把它作为依赖打进 dist（少见）。

import type {
  BeforeCommitHook,
  CommandContext,
  CommandOutput,
  ModuleApi,
  ModuleEntryPoint,
} from "@lukawi/toporealm-module-sdk";

/** 本模块词汇（与 module.yaml kinds 一致；所有权法按 `<namespace>.<kind>` 执法） */
const CARD = "my.card";
const LINKS = "my.links";

/**
 * after-commit 排队追加：写审计对象（不嵌套——队列在 land 后排空）。
 * ⚠ 两个必须知道的语义：
 * ① 守卫：after-commit 里 api.commit 会再次触发 after-commit——不过滤 origin
 *    就是无限审计链。这里只对人类提交（cli/web）记审计。
 * ② undo 提交的 origin 也是 cli——审计会跟着 undo 走；且任何「undo 后的新提交」
 *    会截断 redo 段（core 设计），审计会吃掉紧随 undo 的 redo 能力。
 *    若你的模块不接受，把守卫收紧到只审计前向转换（AfterCommitEvent 无
 *    conversion 字段，可用 label 约定或 payload 特征判定）。
 */
const audit = (api: ModuleApi, event: { revision: number; origin: string }): void => {
  if (event.origin !== "cli" && event.origin !== "web") return;
  api.commit({
    label: `${api.self.id}:audit`,
    changes: [
      {
        op: "put",
        id: `audit-${event.revision}`,
        kind: CARD,
        payload: { title: `rev ${event.revision} 已生效` },
      },
    ],
  });
};

/** before-commit 领域门禁：领域校验的唯一标准形态（core 不聚合、不排序、不 fail-closed） */
const gate: BeforeCommitHook = (c) => {
  // D24①：undo/redo 是已过管线提交的游标移动——撤销是用户的手，领域钩子豁免。
  if (c.conversion === "undo" || c.conversion === "redo") return;

  for (const ch of c.changes) {
    if (ch.op === "put" && ch.kind === CARD) {
      const title = ch.payload?.["title"];
      if (typeof title !== "string" || title.trim().length === 0) {
        // 否决 = 返回 veto 对象（1.2.0 起 details.vetoes[] 带归属模块名）；
        // 也可直接 throw TopoError（VETOED）。
        return { veto: `card 必须有非空 title（id: ${ch.id ?? "匿名"}）` };
      }
    }
  }
  // 放行：不返回（或返回 undefined）
};

function activate(api: ModuleApi): void {
  // ---- 命令（人和 agent 都可调用；目录 id = `<namespace>.<name>`，永远等于注册事实） ----

  // 1) 全局命令（无 target）：创建类命令必须是全局的——绑定 target 的命令要求
  //    目标实体已存在（先有卡才能对卡操作）。
  api.command(
    {
      name: "add-card",
      title:
        "新建 card：必填键 title（放 --input JSON 内，不接受位置参数）；可选键 priority",
      // 全局命令不设 target；input JSON Schema 强烈建议写——cmds 目录即 agent 的唯一文档
      input: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          priority: { type: "string", enum: ["low", "mid", "high"] },
        },
      },
    },
    (ctx: CommandContext): CommandOutput => {
      const title = String(ctx.input["title"] ?? "").trim();
      const priority =
        ctx.input["priority"] === undefined ? undefined : String(ctx.input["priority"]);
      const result = api.commit({
        label: `${api.self.id}:add-card`,
        changes: [
          {
            op: "put",
            id: `card-${Date.now().toString(36)}`,
            kind: CARD,
            payload: { title, priority },
          },
        ],
      });
      return { message: `card 已建（revision ${result.revision}）`, data: result };
    },
  );

  // 2) 绑定目标的命令：ctx.target 为目标实体（调用时以位置参数给实体 id）
  api.command(
    {
      name: "rename-card",
      title: "重命名 card：必填键 title（放 --input JSON 内）",
      target: CARD,
      input: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    },
    (ctx: CommandContext): CommandOutput => {
      const id = ctx.target!.id;
      const title = String(ctx.input["title"] ?? "").trim();
      const result = api.commit({
        label: `${api.self.id}:rename-card`,
        changes: [{ op: "merge", id, payload: { title } }],
      });
      return { message: `card ${id} 已重命名（revision ${result.revision}）` };
    },
  );

  // 3) 全局统计命令：读缝演示——read/get/byKind 都是同步内存态
  api.command(
    {
      name: "stats",
      title: "本模块对象统计。必填键：无",
      input: { type: "object", properties: {} },
    },
    (): CommandOutput => {
      const cards = api.byKind(CARD);
      const links = api.read({ kinds: [LINKS] });
      return {
        message: `cards=${cards.length}, links=${links.entities.length}`,
        data: { cards: cards.map((c) => ({ id: c.id, title: c.payload["title"] })) },
      };
    },
  );

  // ---- 钩子 ----
  api.hook("before-commit", gate);
  api.hook("after-commit", (e) => audit(api, e)); // 排队追加：land 后排空，不阻塞本次返回

  // ---- WebUI inspector 表单（载荷表单投影；目录经 catalog.forms 携带） ----
  api.form(CARD, {
    fields: [
      { name: "title", title: "标题", type: "string", required: true },
      { name: "priority", title: "优先级", type: "enum", options: ["low", "mid", "high"] },
      { name: "notes", title: "备注", type: "text" },
    ],
  });

  // ---- 关系写法（rel 缝；端点必须存在——悬空边检查是 core 仅有的两条执法之二） ----
  // api.commit({
  //   changes: [
  //     { op: "rel", kind: LINKS, id: "lk-1", source: "card-a", target: "card-b" },
  //   ],
  // });

  // 身份自检（可选）：activate 里断言 self 与 module.yaml 一致，漂移早暴露
  if (api.self.namespace !== "my") {
    throw new Error(`namespace 漂移：module.yaml/my 与 self=${api.self.namespace} 不一致`);
  }
}

const myModule: ModuleEntryPoint = { activate };
export default myModule;
