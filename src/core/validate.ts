import type { GraphSnapshot } from "./types.js";
import type { GraphRegistrySnapshot } from "../module-sdk/registry.js";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface GraphValidationResult {
  ok: boolean;
  complete: boolean;
  errors: readonly ValidationIssue[];
  warnings: readonly ValidationIssue[];
}

/** Basic checks are always available; complete checks additionally require module registries. */
export function validateGraph(snapshot: GraphSnapshot, registry?: GraphRegistrySnapshot): GraphValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const object of snapshot.objects) {
    if (ids.has(object.id)) errors.push({ code: "DUPLICATE_ID", message: `重复实体 ID：${object.id}`, severity: "error" });
    ids.add(object.id);
  }
  for (const relation of snapshot.relations) {
    if (ids.has(relation.id)) errors.push({ code: "DUPLICATE_ID", message: `重复实体 ID：${relation.id}`, severity: "error" });
    ids.add(relation.id);
    if (!snapshot.objects.some((object) => object.id === relation.source) || !snapshot.objects.some((object) => object.id === relation.target)) {
      errors.push({ code: "DANGLING_RELATION", message: `关系 ${relation.id} 的端点不存在。`, severity: "error" });
    }
  }
  let complete = registry !== undefined;
  if (!registry) warnings.push({ code: "MODULE_REGISTRY_UNAVAILABLE", message: "未提供模块注册快照，只能报告基础校验。", severity: "warning" });
  else {
    for (const module of registry.modules) {
      if (module.status === "unavailable") {
        complete = false;
        warnings.push({ code: "MODULE_UNAVAILABLE", message: `模块 ${module.id} 不可用：${module.reason ?? "未知原因"}`, severity: "warning" });
      }
    }
  }
  return { ok: errors.length === 0, complete, errors, warnings };
}

