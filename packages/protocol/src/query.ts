import type { EntityId, Kind } from "./entities.js";
import type { EntityRecord } from "./entities.js";

// ---------- 读查询（C-lite；blueprint §1） ----------

export interface ReadQuery {
  /** 各条件取交集 */
  ids?: readonly EntityId[];
  kinds?: readonly Kind[];
  /** payload 顶层浅等值 */
  where?: readonly { kind?: Kind; eq?: Record<string, unknown> }[];
  /** 投影，省 token：id / kind / source / target / payload.<key> */
  fields?: readonly ("id" | "kind" | "source" | "target" | `payload.${string}`)[];
}

export interface ReadResult {
  revision: number;
  entities: readonly EntityRecord[];
}
