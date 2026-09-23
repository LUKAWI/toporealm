import type { Entity, EntityId, Kind, Payload, RelationEntity } from "./entities.js";

// ---------- 变更词汇（三条缝共用，学一次用三处；blueprint §1） ----------

/**
 * 四原语：
 * - put   upsert 对象；匿名 id 由 daemon 生成并按序回显；缺省 kind 仅当目标已存在时合法（保持原 kind）
 * - rel   upsert 关系；id 空间与对象唯一，跨类型占用 = ID_EXISTS
 * - merge 载荷顶层浅合并；值 null = 删键 ★主路径（set 的缺省语义）
 * - del   统一删除对象与关系（id 空间唯一）
 */
export type Change =
  | { op: "put"; kind?: Kind; id?: EntityId; payload?: Payload }
  | {
      op: "rel";
      kind: Kind;
      id?: EntityId;
      source: EntityId;
      target: EntityId;
      payload?: Payload;
      direction?: "directed" | "undirected";
    }
  | { op: "merge"; id: EntityId; payload: Payload }
  | { op: "del"; id: EntityId };

export interface CommitInput {
  /** 原子单位；一次 undo 整体撤销 */
  changes: readonly Change[];
  /** 入提交日志的一句话 */
  label?: string;
  /** 可选乐观护航；缺省 = 无条件（单属主队列天然串行） */
  ifRevision?: number;
}

export interface CommitResult {
  revision: number;
  /** daemon 分配的 id 按序回显（免二次 read） */
  created: readonly EntityId[];
  patch: GraphPatch;
  canUndo: boolean;
  canRedo: boolean;
}

/** 集合分桶 patch（B）：未来新资源种类 = 增量桶，契约不破 */
export interface GraphPatch {
  /** 恒等于前一 revision（缺口只可能因客户端丢事件） */
  fromRevision: number;
  toRevision: number;
  objects: {
    added: readonly Entity[];
    updated: readonly Entity[];
    deleted: readonly EntityId[];
  };
  relations: {
    added: readonly RelationEntity[];
    updated: readonly RelationEntity[];
    deleted: readonly EntityId[];
  };
}
