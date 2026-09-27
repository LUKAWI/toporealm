import type { EntityId, Kind } from "./entities.js";
import type { EntityRecord } from "./entities.js";

// ---------- 读查询（C-lite；blueprint §1） ----------

export interface ReadQuery {
  /** 各条件取交集 */
  ids?: readonly EntityId[];
  kinds?: readonly Kind[];
  /**
   * 邻域过滤（D36 协议加法）：锚实体 id。命中 = 锚实体自身 + 与它相触的关系
   * （关系的 source 或 target 为锚；悬空边执法保证端点必为对象，故关系锚不触达其他关系）。
   * 与其余条件取交集（叠加既有过滤）；锚不存在 → 空集（read 是纯过滤面，不抛 UNKNOWN_ID，
   * 由调用方自行判定）。排序沿用既有遍历序：锚在前（对象段先于关系段），相触关系按入图序。
   */
  adjacent?: EntityId;
  /** payload 顶层浅等值 */
  where?: readonly { kind?: Kind; eq?: Record<string, unknown> }[];
  /** 投影，省 token：id / kind / source / target / payload.<key> */
  fields?: readonly ("id" | "kind" | "source" | "target" | `payload.${string}`)[];
}

export interface ReadResult {
  revision: number;
  entities: readonly EntityRecord[];
}
