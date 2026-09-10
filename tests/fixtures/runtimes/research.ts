import type { ActionContext, ActionOutput, ModuleActionRuntime } from "../../../src/module-sdk/index.js";

export const researchFixtureSources = [
  {
    id: "source-local-1",
    title: "离线资料：图模型与可追溯论点",
    uri: "fixture://research/local-1",
    excerpt: "可追溯研究把问题、来源与论点通过显式关系连接起来。",
  },
  {
    id: "source-local-2",
    title: "离线资料：增量图更新",
    uri: "fixture://research/local-2",
    excerpt: "事实级 patch 可以在不重建整张画布的情况下更新局部视图。",
  },
] as const;

export function createResearchRuntime(): ModuleActionRuntime {
  return {
    execute(operation: string, context: ActionContext): ActionOutput {
      if (operation !== "research.expand-question") throw new Error(`未知 research 操作：${operation}`);
      const target = context.target;
      if (!target) throw new Error("research.expand-question 需要 question 目标。");
      const question = context.snapshot.objects.find((object) => object.id === target);
      if (!question || question.kind !== "research.question") throw new Error("目标不是 research.question。");
      const depth = context.input.depth;
      if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error("depth 必须是 1 到 3 的整数。");
      const source = researchFixtureSources[0];
      const sourceId = `${target}-source`;
      const claimId = `${target}-claim`;
      return {
        label: "离线展开研究问题",
        mutations: [
          { op: "upsert_object", object: { id: sourceId, kind: "research.source", label: source.title, data: { uri: source.uri, excerpt: source.excerpt } } },
          { op: "upsert_object", object: { id: claimId, kind: "research.claim", label: `关于 ${question.label} 的离线论点`, data: { depth, text: source.excerpt } } },
          { op: "upsert_relation", relation: { id: `${sourceId}-supports-${claimId}`, kind: "research.supports", source: sourceId, target: claimId, direction: "directed", data: { fixture: true } } },
          { op: "upsert_relation", relation: { id: `${claimId}-supports-${target}`, kind: "research.supports", source: claimId, target, direction: "directed", data: { fixture: true } } },
        ],
      };
    },
  };
}
