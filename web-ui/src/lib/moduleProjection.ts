import type { ModuleOperation, ModuleStatusResult } from "./protocol";

export interface ModulePresentation {
  color?: string;
  icon?: string;
}

export interface ModuleOperationProjection {
  operation: string;
  inputSchema?: string;
  inputTemplate?: unknown;
}

export interface ModuleProjection {
  kind: string;
  moduleId?: string;
  available: boolean;
  reason?: string;
  presentation?: ModulePresentation;
  fields: string[];
  operations: ModuleOperationProjection[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function moduleForKind(kind: string, registry: ModuleStatusResult): { id: string; available: boolean; reason?: string } | undefined {
  const namespace = kind.includes(".") ? kind.slice(0, kind.indexOf(".")) : undefined;
  if (!namespace) return undefined;
  const module = registry.modules.find((candidate) => candidate.id === namespace || candidate.namespace === namespace);
  if (!module) return { id: namespace, available: false, reason: "当前图未注册此命名空间。" };
  return { id: module.id, available: module.status === "available", reason: module.reason };
}

function projectionForUi(kind: string, moduleId: string, registry: ModuleStatusResult): Pick<ModuleProjection, "presentation" | "fields"> {
  const moduleUi = record(registry.ui?.[moduleId]);
  const presentationValue = record(record(moduleUi.presentation)[kind]);
  const presentation: ModulePresentation = {};
  if (typeof presentationValue.color === "string") presentation.color = presentationValue.color;
  if (typeof presentationValue.icon === "string") presentation.icon = presentationValue.icon;
  const fieldsValue = record(moduleUi.forms)[kind];
  const fields = Array.isArray(fieldsValue) ? fieldsValue.filter((field): field is string => typeof field === "string") : [];
  return { presentation: Object.keys(presentation).length ? presentation : undefined, fields };
}

function operationProjection(operation: ModuleOperation): ModuleOperationProjection {
  const declaration = record(operation.declaration);
  const result: ModuleOperationProjection = { operation: operation.fullId };
  if (typeof declaration.input_schema === "string") result.inputSchema = declaration.input_schema;
  if (declaration.input_template !== undefined) result.inputTemplate = declaration.input_template;
  return result;
}

/** 未声明 presentation 时的确定性回退色（深空柔和档）：kind → 稳定色相。 */
const KIND_PALETTE = ["#5b8def", "#34c98d", "#e8a54b", "#d96a8b", "#9b7fe6", "#4bbcbc", "#c9b458", "#8a95a5"];

export function fallbackKindColor(kind: string): string {
  let hash = 0;
  for (let i = 0; i < kind.length; i++) hash = (hash * 31 + kind.charCodeAt(i)) | 0;
  return KIND_PALETTE[Math.abs(hash) % KIND_PALETTE.length];
}

/** 画布/图例共用的 kind 色：模块 presentation 优先，未声明时确定性回退。 */
export function kindColorOf(kind: string, registry: ModuleStatusResult | null): string {
  return projectModuleKind(kind, registry).presentation?.color ?? fallbackKindColor(kind);
}

/** Converts declaration data to a fixed Web slot without hard-coded domain branches. */
export function projectModuleKind(kind: string, registry: ModuleStatusResult | null): ModuleProjection {
  const base: ModuleProjection = { kind, available: true, fields: [], operations: [] };
  if (!registry) return base;
  const owner = moduleForKind(kind, registry);
  if (!owner) return base;
  base.moduleId = owner.id;
  base.available = owner.available;
  if (owner.reason !== undefined) base.reason = owner.reason;
  if (!owner.available) return base;
  const ui = projectionForUi(kind, owner.id, registry);
  if (ui.presentation !== undefined) base.presentation = ui.presentation;
  base.fields = ui.fields;
  base.operations = (registry.operations ?? [])
    .filter((operation) => record(operation.declaration).applies_to === kind)
    .map(operationProjection);
  return base;
}
