import { CoreError } from "../core/errors.js";
import type { ManagedGraph, ManagedGraphMutationResult } from "../core/managed.js";
import type { GraphSnapshot, MutationPlan } from "../core/types.js";
import type { ActionReference, GraphRegistrySnapshot } from "./registry.js";
import { validateMutationPlan } from "./registry.js";

export interface ActionContext {
  snapshot: GraphSnapshot;
  target?: string;
  input: Record<string, unknown>;
}

export type ActionOutput = MutationPlan | { result: unknown; effects?: "none" | "artifact" | "external" };

export interface ModuleActionRuntime {
  execute(operation: string, context: ActionContext): ActionOutput | Promise<ActionOutput>;
}

export type ActionRuntimeMap = Readonly<Record<string, Partial<ModuleActionRuntime>>>;

export type ActionExecutionResult =
  | { kind: "mutation"; operation: string; mutation: ManagedGraphMutationResult }
  | { kind: "result"; operation: string; result: unknown; effects: "none" | "artifact" | "external" };

function isMutationPlan(value: ActionOutput): value is MutationPlan {
  return Boolean(value && typeof value === "object" && Array.isArray((value as MutationPlan).mutations));
}

export class ActionExecutor {
  constructor(
    private readonly graph: ManagedGraph,
    private readonly registry: GraphRegistrySnapshot,
    private readonly runtimes: ActionRuntimeMap,
  ) {}

  async execute(reference: ActionReference, input: Record<string, unknown> = {}): Promise<ActionExecutionResult> {
    if (reference.registryRevision !== this.registry.registryRevision) {
      throw new CoreError({ code: "STALE_ACTION", message: "动作引用来自旧的模块注册快照，请重新发现动作。", details: { expectedRevision: this.registry.registryRevision, actionRevision: reference.registryRevision } });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new CoreError({ code: "INVALID_INPUT", message: "动作输入必须是对象。" });
    }
    const operation = this.registry.operations.find((candidate) => candidate.fullId === reference.operation);
    if (!operation) throw new CoreError({ code: "ACTION_NOT_FOUND", message: `找不到动作：${reference.operation}` });
    const module = this.registry.modules.find((candidate) => candidate.id === operation.moduleId);
    if (!module || module.status !== "available") throw new CoreError({ code: "MODULE_UNAVAILABLE", message: `动作所属模块不可用：${operation.moduleId}` });
    if (reference.target !== undefined) {
      const snapshot = this.graph.read().snapshot;
      const target = snapshot.objects.find((object) => object.id === reference.target) ?? snapshot.relations.find((relation) => relation.id === reference.target);
      if (!target) throw new CoreError({ code: "ACTION_NOT_APPLICABLE", message: `动作目标不存在：${reference.target}` });
      const declaration = operation.declaration && typeof operation.declaration === "object" ? operation.declaration as Record<string, unknown> : {};
      if (typeof declaration.applies_to === "string" && (target as { kind: string }).kind !== declaration.applies_to) {
        throw new CoreError({ code: "ACTION_NOT_APPLICABLE", message: `动作 ${reference.operation} 不适用于 ${(target as { kind: string }).kind}。` });
      }
    }
    const runtime = this.runtimes[operation.moduleId];
    if (!runtime || typeof runtime.execute !== "function") throw new CoreError({ code: "RUNTIME_FAILED", message: `模块 ${operation.moduleId} 没有可用运行时。` });
    let output: ActionOutput;
    try {
      const context: ActionContext = { snapshot: this.graph.read().snapshot, input };
      if (reference.target !== undefined) context.target = reference.target;
      output = await runtime.execute(operation.fullId, context);
    } catch (error) {
      throw new CoreError({ code: "RUNTIME_FAILED", message: `动作 ${reference.operation} 执行失败。`, details: { cause: error instanceof Error ? error.message : String(error) } });
    }
    if (isMutationPlan(output)) {
      validateMutationPlan(this.registry, output);
      return { kind: "mutation", operation: reference.operation, mutation: this.graph.commit(output) };
    }
    return { kind: "result", operation: reference.operation, result: output.result, effects: output.effects ?? "none" };
  }
}
