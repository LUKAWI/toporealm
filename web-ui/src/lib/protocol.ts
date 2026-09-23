// Browser-facing seam on the 1.0 protocol（blueprint §1，D22 裁决④ replace don't layer）。
// 契约类型唯一来源是 @lukawi/toporealm-protocol（protocol ← web-ui 单向依赖）；
// 这里只补浏览器视图词汇：画布选择、标题投影、本地 revision 化投影状态。
import {
  TopoError,
  isRelation,
  type Catalog,
  type CatalogEntry,
  type Change,
  type CommandRunResult,
  type CommitInput,
  type CommitResult,
  type Entity,
  type EntityId,
  type EntityRecord,
  type GraphPatch,
  type GraphSnapshot,
  type GraphSummary,
  type ReadQuery,
  type ReadResult,
  type RelationEntity,
  type Session,
  type TopoEvent,
} from "@lukawi/toporealm-protocol";

export type {
  Catalog,
  CatalogEntry,
  Change,
  CommandRunResult,
  CommitInput,
  CommitResult,
  Entity,
  EntityId,
  EntityRecord,
  GraphPatch,
  GraphSnapshot,
  GraphSummary,
  ReadQuery,
  ReadResult,
  RelationEntity,
  Session,
  TopoEvent,
};
// TopoError 以值复出（测试与组件要 new 它）；isRelation 同为运行时函数。
export { isRelation, TopoError };

/** 画布/抽屉共用的视图选择（纯浏览器状态，不进 daemon 缝）。 */
export type CanvasSelection = { type: "object" | "relation"; id: string };

/** 显示名约定投影（blueprint §1：payload.title；module.yaml titleKey 属声明层投影，目录先行）。 */
export function titleOf(entity: Entity | EntityRecord): string {
  const title = entity.payload?.["title"];
  return typeof title === "string" ? title : "";
}

/** 画布/列表标签：title 缺省回落 id（1.0 不再有必填 label 字段）。 */
export function displayOf(entity: Entity | EntityRecord): string {
  return titleOf(entity) || entity.id;
}

/** 乐观护航等可自愈错误的统一判别（恢复 = 全量重读服务器真相）。 */
export function isRecoverableError(error: unknown): error is TopoError | PatchGapError {
  return (
    (error instanceof TopoError && error.code === "IF_REVISION_MISMATCH") ||
    error instanceof PatchGapError
  );
}

/**
 * 本地 patch gap 的视图层错误（PATCH_GAP 不在 §1.1 封闭错误码集——它不过 wire，
 * 是 WebGraphState 的本地信号；store 捕获后进入 recovery 自愈）。
 */
export class PatchGapError extends Error {
  readonly code = "PATCH_GAP";
  readonly expectedRevision: number;
  readonly patchFrom: number;

  constructor(expected: number, got: number) {
    super(`实时更新存在版本缺口：当前 r${expected}，收到 r${got}。`);
    this.name = "PatchGapError";
    this.expectedRevision = expected;
    this.patchFrom = got;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 本地 revision 化投影：连续 patch 增量推进；缺口（fromRevision ≠ 本地 revision）
 * 抛 PatchGapError 且绝不改写当前快照（不变量 I3 的浏览器侧兜底）。
 */
export class WebGraphState {
  private current: GraphSnapshot;

  constructor(snapshot: GraphSnapshot) {
    this.current = clone(snapshot);
  }

  get snapshot(): GraphSnapshot {
    return clone(this.current);
  }

  get revision(): number {
    return this.current.revision;
  }

  applyPatch(patch: GraphPatch): GraphSnapshot {
    if (patch.fromRevision !== this.current.revision) {
      throw new PatchGapError(this.current.revision, patch.fromRevision);
    }
    if (patch.toRevision < patch.fromRevision) {
      throw new PatchGapError(this.current.revision, patch.toRevision);
    }
    const objects = new Map(this.current.objects.map((object) => [object.id, clone(object)]));
    const relations = new Map(this.current.relations.map((relation) => [relation.id, clone(relation)]));
    for (const object of patch.objects.added) objects.set(object.id, clone(object));
    for (const object of patch.objects.updated) objects.set(object.id, clone(object));
    for (const id of patch.objects.deleted) objects.delete(id);
    for (const relation of patch.relations.added) relations.set(relation.id, clone(relation));
    for (const relation of patch.relations.updated) relations.set(relation.id, clone(relation));
    for (const id of patch.relations.deleted) relations.delete(id);
    this.current = {
      graphId: this.current.graphId,
      revision: patch.toRevision,
      objects: [...objects.values()],
      relations: [...relations.values()],
    };
    return this.snapshot;
  }

  /** 全量替换（reload/自愈路径）。 */
  reset(snapshot: GraphSnapshot): void {
    this.current = clone(snapshot);
  }
}
