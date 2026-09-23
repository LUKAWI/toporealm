// ---------- module-sdk：模块作者的类型面（blueprint §2） ----------
//
// 纯类型包：re-export protocol 的模块契约（S2，blueprint §1.2），外加 defineModule()
// 类型帮助。唯一运行时代码是恒等函数 defineModule（零逻辑、零依赖）；
// 它的存在只为让模块入口获得精确的类型检查与编辑器补全。

import type { ModuleEntryPoint } from "@lukawi/toporealm-protocol";

export type {
  // S2 模块 runtime API
  ModuleEntryPoint,
  ModuleApi,
  CommandSpec,
  CommandContext,
  CommandOutput,
  CommandHandler,
  CommitCandidate,
  BeforeCommitHook,
  AfterCommitEvent,
  AfterCommitHook,
  FormSpec,
  // 模块代码会直接触碰的契约词汇
  Change,
  CommitInput,
  CommitResult,
  GraphPatch,
  GraphSnapshot,
  Entity,
  RelationEntity,
  EntityRecord,
  EntityId,
  Kind,
  Payload,
  Origin,
  ReadQuery,
  ReadResult,
  CatalogEntry,
} from "@lukawi/toporealm-protocol";

/**
 * 模块入口类型帮助（恒等函数；blueprint §2）：
 *
 * ```ts
 * import { defineModule } from "@lukawi/toporealm-module-sdk";
 *
 * export default defineModule({
 *   activate(api) {
 *     api.command({ name: "start", title: "开始任务", target: "wf.task" }, (ctx) => { … });
 *   },
 * });
 * ```
 *
 * 行为全部在 activate 里注册（双层模块，声明层 module.yaml 只管协调）；
 * 注册面在 activate 返回后冻结，迟到的注册会得到 LATE_REGISTRATION。
 */
export function defineModule<M extends ModuleEntryPoint>(m: M): M {
  return m;
}
