import type { EntityId, Kind } from "./entities.js";
import type { FormSpec } from "./module.js";

// ---------- 命令目录（D12：daemon 自省，永远等于注册事实；blueprint §1） ----------

export interface CatalogEntry {
  /** 全名恒含点号："wf.start" */
  id: string;
  module: string;
  /** agent 的唯一必读文档 */
  title: string;
  /** appliesTo；缺省 = 全局命令 */
  target?: Kind;
  /** JSON Schema——说明书，不是门禁（执法仅两条） */
  input?: object;
}

export interface Catalog {
  modules: readonly { id: string; version: string; namespace: string }[];
  kinds: readonly { kind: Kind; owner?: string; color?: string; icon?: string }[];
  commands: readonly CatalogEntry[];
  /** D24②：api.form 注册面的目录投影（仅非空时携带）；WebUI inspector 表单从目录读取 */
  forms?: readonly { kind: Kind; form: FormSpec }[];
}

export interface CommandRunResult {
  message?: string;
  data?: unknown;
  commits?: readonly import("./changes.js").CommitResult[];
}
