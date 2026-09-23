// 目录投影（blueprint §1 Catalog + D22 裁决④）：kind 的色彩/图标与 appliesTo 命令
// 全部来自 daemon 目录真相（catalog()），Web 不硬编码任何领域分支。
// 声明层的 forms/titleKey 等 ui 投影按 §7 预留（复杂视图 v1.1）。
import type { Catalog } from "./protocol";

export interface ModulePresentation {
  color?: string;
  icon?: string;
}

export interface KindCommandProjection {
  /** 目录全名（恒含点号）：wf.start */
  commandId: string;
  title: string;
  /** JSON Schema 说明书（不是门禁）；M3 以空 input 直发 */
  input?: object;
}

export interface ModuleProjection {
  kind: string;
  /** 拥有该命名空间的模块 id（目录 modules 匹配） */
  moduleId?: string;
  /** 命名空间有属主模块 = 可用（1.0 目录里模块在场即已装载） */
  available: boolean;
  /** 目录 kinds 声明的样式（kinds.color/icon） */
  presentation?: ModulePresentation;
  commands: KindCommandProjection[];
}

function namespaceOf(kind: string): string | undefined {
  return kind.includes(".") ? kind.slice(0, kind.indexOf(".")) : undefined;
}

/** 未声明 presentation 时的确定性回退色（深空柔和档）：kind → 稳定色相。 */
const KIND_PALETTE = ["#5b8def", "#34c98d", "#e8a54b", "#d96a8b", "#9b7fe6", "#4bbcbc", "#c9b458", "#8a95a5"];

export function fallbackKindColor(kind: string): string {
  let hash = 0;
  for (let i = 0; i < kind.length; i++) hash = (hash * 31 + kind.charCodeAt(i)) | 0;
  return KIND_PALETTE[Math.abs(hash) % KIND_PALETTE.length];
}

/** 画布/图例共用的 kind 色：目录 kinds.color 优先，未声明时确定性回退。 */
export function kindColorOf(kind: string, catalog: Catalog | null): string {
  return projectModuleKind(kind, catalog).presentation?.color ?? fallbackKindColor(kind);
}

/** 目录 → 固定 Web 插槽投影（样式 + appliesTo 命令）；无目录也能降级呈现。 */
export function projectModuleKind(kind: string, catalog: Catalog | null): ModuleProjection {
  const base: ModuleProjection = { kind, available: true, commands: [] };
  const ns = namespaceOf(kind);
  if (ns === undefined) return base;

  const owner = catalog?.modules.find((m) => m.namespace === ns || m.id === ns);
  if (!owner) {
    // 命名空间有点号但目录无属主 = 模块未装载；目录未加载（null）时不妄断降级
    base.available = catalog === null;
    return base;
  }
  base.moduleId = owner.id;

  const kindEntry = (catalog?.kinds ?? []).find((k) => k.kind === kind);
  const presentation: ModulePresentation = {};
  if (typeof kindEntry?.color === "string") presentation.color = kindEntry.color;
  if (typeof kindEntry?.icon === "string") presentation.icon = kindEntry.icon;
  if (Object.keys(presentation).length > 0) base.presentation = presentation;

  base.commands = (catalog?.commands ?? [])
    .filter((command) => command.target === kind)
    .map((command) => ({
      commandId: command.id,
      title: command.title,
      ...(command.input !== undefined ? { input: command.input } : {}),
    }));
  return base;
}
