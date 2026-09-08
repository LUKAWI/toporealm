import { cpSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/core/index.js";
import { createWorkflowRuntime } from "../src/modules/index.js";
import { ActionExecutor, GraphActivator, WorkspaceModuleResolver, discoverActions } from "../src/module-sdk/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiedFixture(): { root: string; store: GraphStore } {
  const base = mkdtempSync(join(tmpdir(), "toporealm-m4-"));
  roots.push(base);
  const root = join(base, "workspace");
  mkdirSync(root, { recursive: true });
  const here = dirname(fileURLToPath(import.meta.url));
  cpSync(resolve(here, "../fixtures/workflow-slice"), root, { recursive: true });
  cpSync(resolve(here, "../fixtures/modules"), join(base, "modules"), { recursive: true });
  return { root, store: GraphStore.fromWorkspace(root, "workflow-demo") };
}

function action(executor: ActionExecutor, registry: ReturnType<GraphActivator["activate"]>, name: string, target?: string) {
  const reference = discoverActions(registry, target).find((item) => item.operation === name);
  if (!reference) throw new Error(`缺少动作：${name}`);
  return (input: Record<string, unknown> = {}) => executor.execute(reference, input);
}

describe("workflow representative slice", () => {
  it("在模块内执行状态流转、依赖门禁、checkpoint/report 与下一行动", async () => {
    const { root, store } = copiedFixture();
    const registry = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    const executor = new ActionExecutor(store, registry, { workflow: createWorkflowRuntime() });
    const next = action(executor, registry, "workflow.next-actions");
    const transitionA = action(executor, registry, "workflow.transition-task", "task-a");
    const transitionB = action(executor, registry, "workflow.transition-task", "task-b");
    const checkpointB = action(executor, registry, "workflow.record-checkpoint", "task-b");
    const reportB = action(executor, registry, "workflow.record-report", "task-b");

    const first = await next();
    expect(first).toMatchObject({ kind: "result", result: { ready: [{ id: "task-a" }] } });
    await expect(transitionB({ status: "ready" })).rejects.toThrow(/执行失败/);
    await transitionA({ status: "ready" });
    await transitionA({ status: "running" });
    await transitionA({ status: "passed" });
    expect((await next())).toMatchObject({ kind: "result", result: { ready: [{ id: "task-b" }] } });
    await transitionB({ status: "ready" });
    await transitionB({ status: "running" });
    await checkpointB({ id: "build", status: "passed" });
    await reportB({ summary: "workflow representative slice passed" });
    await transitionB({ status: "passed" });

    const final = store.read();
    expect(final.objects.find((object) => object.id === "task-b")?.data?.status).toBe("passed");
    expect(final.objects.some((object) => object.kind === "workflow.checkpoint")).toBe(true);
    expect(final.objects.some((object) => object.kind === "workflow.execution_report")).toBe(true);
    expect(final.relations.some((relation) => relation.kind === "workflow.depends_on")).toBe(true);
  });

  it("workflow 字段只存在于模块数据，Core 仍只暴露通用对象/关系", () => {
    const { root, store } = copiedFixture();
    const registry = new GraphActivator(new WorkspaceModuleResolver(root)).activate(store.read());
    expect(registry.objectKinds.map((kind) => kind.fullId)).toContain("workflow.task");
    expect(store.read().manifest.format).toBe("toporealm.graph/v1alpha1");
  });
});
