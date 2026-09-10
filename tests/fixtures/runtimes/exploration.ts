import type { ActionContext, ActionOutput, ModuleActionRuntime } from "../../../src/module-sdk/index.js";

export function createExplorationRuntime(): ModuleActionRuntime {
  return {
    execute(operation: string, context: ActionContext): ActionOutput {
      if (operation !== "exploration.open-unknown") throw new Error(`未知 exploration 操作：${operation}`);
      const label = context.input.label;
      if (typeof label !== "string" || !label.trim()) throw new Error("label 不能为空。");
      const id = context.target ?? `unknown-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      return {
        label: "记录探索未知",
        mutations: [{ op: "upsert_object", object: { id, kind: "exploration.unknown", label, data: { status: "open" } } }],
      };
    },
  };
}
