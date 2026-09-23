// ---------- 基础词汇（blueprint §1，最小信封 D3） ----------

/** 实体 id。磁盘文件名安全：禁 / \ : 与控制字符（校验见 id.ts）。 */
export type EntityId = string;

/** 主类型。命名空间化："wf.task"；无点号 = 公共/无主。 */
export type Kind = string;

/** 载荷：core 原样存取、永不解释的不透明数据区域。 */
export type Payload = Record<string, unknown>;

/** 提交来源。所有权法只约束 `module:*`；cli/web/external/migrate 豁免（人是图最终属主）。 */
export type Origin = "cli" | "web" | `module:${string}` | "external" | "migrate";

/** 最小信封：core 知道的一切。 */
export interface Entity {
  id: EntityId;
  kind: Kind;
  payload: Payload;
}

export interface RelationEntity extends Entity {
  /** 结构字段：悬空边检查的唯一依据 */
  source: EntityId;
  target: EntityId;
  /** 可选，缺省 "directed"（D17 默认值；不占执法） */
  direction?: "directed" | "undirected";
}

/** 对象或关系。判别："source" in r */
export type EntityRecord = Entity | RelationEntity;

export function isRelation(r: EntityRecord): r is RelationEntity {
  return "source" in r;
}

export interface GraphSnapshot {
  graphId: string;
  /** 单调，每次转换 +1 */
  revision: number;
  objects: readonly Entity[];
  relations: readonly RelationEntity[];
}

export interface GraphSummary {
  graphId: string;
  revision: number;
  counts: Readonly<Record<Kind, number>>;
  /** 已装载模块 id（M1 无模块系统，恒为空数组） */
  modules: readonly string[];
  canUndo: boolean;
  canRedo: boolean;
}
