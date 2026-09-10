import type { ActionContext, ActionOutput, ModuleActionRuntime } from "../../../src/module-sdk/index.js";

type WorkflowStatus = "pending" | "ready" | "running" | "passed" | "failed" | "blocked" | "cancelled";

const transitions: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["passed", "failed", "blocked", "cancelled"],
  passed: [],
  failed: ["pending", "ready"],
  blocked: ["pending", "ready"],
  cancelled: ["pending"],
};

function taskStatus(object: { data?: Record<string, unknown> }): WorkflowStatus {
  const status = object.data?.status;
  return typeof status === "string" && status in transitions ? status as WorkflowStatus : "pending";
}

function dependencyIds(context: ActionContext, taskId: string): string[] {
  return context.snapshot.relations
    .filter((relation) => relation.kind === "workflow.depends_on" && relation.target === taskId)
    .map((relation) => relation.source);
}

function nextActions(context: ActionContext): Array<{ id: string; label: string }> {
  return context.snapshot.objects
    .filter((object) => object.kind === "workflow.task" && taskStatus(object) === "pending")
    .filter((object) => dependencyIds(context, object.id).every((dependency) => {
      const prerequisite = context.snapshot.objects.find((candidate) => candidate.id === dependency);
      return prerequisite !== undefined && taskStatus(prerequisite) === "passed";
    }))
    .map((object) => ({ id: object.id, label: object.label }));
}

export function createWorkflowRuntime(): ModuleActionRuntime {
  return {
    execute(operation: string, context: ActionContext): ActionOutput {
      if (operation === "workflow.next-actions") return { result: { ready: nextActions(context) }, effects: "none" };
      const target = context.target;
      if (!target) throw new Error("workflow 操作需要 task 目标。");
      const task = context.snapshot.objects.find((object) => object.id === target && object.kind === "workflow.task");
      if (!task) throw new Error(`找不到 workflow.task：${target}`);

      if (operation === "workflow.transition-task") {
        const status = context.input.status;
        if (typeof status !== "string" || !(status in transitions)) throw new Error("status 不是有效 workflow 状态。");
        const current = taskStatus(task);
        if (!transitions[current].includes(status as WorkflowStatus)) throw new Error(`不允许从 ${current} 转为 ${status}。`);
        if (status === "ready" && !dependencyIds(context, target).every((dependency) => {
          const prerequisite = context.snapshot.objects.find((candidate) => candidate.id === dependency);
          return prerequisite !== undefined && taskStatus(prerequisite) === "passed";
        })) throw new Error("前置任务尚未全部 passed，不能进入 ready。");
        return {
          label: `workflow: ${target} -> ${status}`,
          mutations: [{ op: "upsert_object", object: { ...task, data: { ...(task.data ?? {}), status } } }],
        };
      }

      if (operation === "workflow.record-checkpoint") {
        const checkpointId = context.input.id;
        const status = context.input.status;
        if (typeof checkpointId !== "string" || typeof status !== "string") throw new Error("checkpoint 需要 id 和 status。");
        const id = `${target}-checkpoint-${checkpointId}`;
        return {
          label: `记录 checkpoint ${checkpointId}`,
          mutations: [
            { op: "upsert_object", object: { id, kind: "workflow.checkpoint", label: checkpointId, data: { status, task: target } } },
            { op: "upsert_relation", relation: { id: `${id}-for-${target}`, kind: "workflow.checkpoint_for", source: id, target, direction: "directed" } },
          ],
        };
      }

      if (operation === "workflow.record-report") {
        const summary = context.input.summary;
        if (typeof summary !== "string" || !summary.trim()) throw new Error("execution report summary 不能为空。");
        const id = `${target}-report`;
        return {
          label: `记录 execution report ${target}`,
          mutations: [
            { op: "upsert_object", object: { id, kind: "workflow.execution_report", label: "Execution report", data: { summary, task: target } } },
            { op: "upsert_relation", relation: { id: `${id}-for-${target}`, kind: "workflow.report_for", source: id, target, direction: "directed" } },
          ],
        };
      }
      throw new Error(`未知 workflow 操作：${operation}`);
    },
  };
}
