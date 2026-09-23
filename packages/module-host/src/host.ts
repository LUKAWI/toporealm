import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  TopoError,
  isValidKind,
  kindNamespace,
  suggestClosest,
  type AfterCommitHook,
  type BeforeCommitHook,
  type Catalog,
  type CatalogEntry,
  type CommandHandler,
  type CommandOutput,
  type CommandRunResult,
  type CommandSpec,
  type CommitResult,
  type EntityId,
  type EntityRecord,
  type FormSpec,
  type Kind,
  type ModuleApi,
  type ModuleEntryPoint,
  type ModuleManifestV2,
} from "@lukawi/toporealm-protocol";
import type { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { parse } from "yaml";
import {
  moduleBindingDigest,
  readModuleBindings,
  resolveModuleDir,
} from "./bindings.js";

// ---------- ModuleHost：模块发现/装载/目录聚合/命令分发（blueprint §2） ----------
//
// 红线自查：只依赖 daemon-core 暴露的管线入口（read/commitSync/钩子注册面）+ protocol；
// 双层模块——声明层 module.yaml 只管协调（kinds/ui 投影、requires 排序），不是执法依据（D8）；
// 行为全部在 activate 里注册；注册面 activate 返回后冻结（M1 不变量，违者 LATE_REGISTRATION）。

export interface ModuleHostLoadOptions {
  root: string;
  /** warning 下沉口（声明词汇偏差、global 来源跳过等）；同时累积在 host.warnings */
  onWarning?: (message: string) => void;
}

interface LoadedModule {
  id: string;
  namespace: string;
  version: string;
  manifest: ModuleManifestV2;
  dir: string;
  /** 声明的全量 kind（ns.name）；目录投影与词汇偏差检查（M5 warning）用 */
  declaredKinds: Set<Kind>;
  /** 注册面冻结开关：activate 返回后置 true */
  frozen: boolean;
}

interface RegisteredCommand {
  moduleId: string;
  spec: CommandSpec;
  handler: CommandHandler;
}

export class ModuleHost {
  private constructor(private readonly core: DaemonCore) {}

  private readonly loaded = new Map<string, LoadedModule>();
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly forms = new Map<Kind, FormSpec>();
  private readonly warnings_: string[] = [];
  private readonly warnedVocabulary = new Set<string>();
  /** 命令执行期收集 api.commit 结果（CommandRunResult.commits） */
  private currentCommits: CommitResult[] | null = null;
  private digest_ = "";

  /** 已装载模块 id（激活序 = 依赖拓扑序） */
  get loadedIds(): readonly string[] {
    return [...this.loaded.keys()];
  }

  /** 装载时记录的 modules.yaml 摘要（daemon hello 复验基准） */
  get digest(): string {
    return this.digest_;
  }

  get warnings(): readonly string[] {
    return [...this.warnings_, ...this.core.warnings];
  }

  /** WebUI inspector 表单投影（M3 读；M2 仅注册与存储） */
  form(kind: Kind): FormSpec | undefined {
    return this.forms.get(kind);
  }

  // ---------- 装载 ----------

  static async load(core: DaemonCore, opts: ModuleHostLoadOptions): Promise<ModuleHost> {
    const host = new ModuleHost(core);
    host.onWarningCb = opts.onWarning;
    const { bindings, raw } = await readModuleBindings(opts.root);
    host.digest_ = moduleBindingDigest(raw);

    // ① 解析绑定 → 读声明（module.yaml v2）
    const resolved = new Map<string, { manifest: ModuleManifestV2; dir: string }>();
    for (const [id, binding] of Object.entries(bindings)) {
      if (binding.source === "global") {
        // M4 安装器交付前的已知空档：跳过并点名，不静默
        host.warn(`模块 "${id}" 是 global 来源：M4 安装器交付前跳过`);
        continue;
      }
      const dir = resolveModuleDir(opts.root, id, binding);
      resolved.set(id, { manifest: await host.parseManifest(dir, id), dir });
    }

    // ② 命名空间唯一
    const byNs = new Map<string, string>();
    for (const [id, { manifest }] of resolved) {
      const prev = byNs.get(manifest.namespace);
      if (prev !== undefined) {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `命名空间冲突："${manifest.namespace}" 同时属于模块 "${prev}" 与 "${id}"`,
          details: { namespace: manifest.namespace, modules: [prev, id] },
        });
      }
      byNs.set(manifest.namespace, id);
    }

    // ③ requires.modules 完备性（M6：不满足 → daemon 拒绝启动，点名缺失）
    for (const [id, { manifest }] of resolved) {
      const missing = (manifest.requires?.modules ?? []).filter((r) => !resolved.has(r));
      if (missing.length > 0) {
        throw new TopoError({
          code: "MISSING_MODULE",
          message: `模块 "${id}" 的依赖未装载：${missing.join(", ")}`,
          hint: "requires.modules 必须先绑定；补齐后重启 daemon（客户端下次触达自动拉起）",
          fix: `toporealm module add ${missing[0]}`,
          details: { module: id, missing },
        });
      }
    }

    // ④ 依赖拓扑排序（Kahn；循环依赖 = 启动大声失败）
    const order = topoSort(resolved);

    // ⑤ 依序 activate（恰好一次）；全部成功后冻结模块集
    for (const id of order) {
      const r = resolved.get(id)!;
      await host.activateModule(id, r.manifest, r.dir);
    }
    core.setLoadedModules(host.loadedIds);
    host.installVocabularyObserver();
    return host;
  }

  private warn(message: string): void {
    this.warnings_.push(message);
    this.onWarningCb?.(message);
  }
  private onWarningCb: ((message: string) => void) | undefined;

  private async parseManifest(dir: string, boundId: string): Promise<ModuleManifestV2> {
    const file = path.join(dir, "module.yaml");
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `模块 "${boundId}" 缺少 module.yaml（${dir}）`,
          details: { module: boundId, dir },
        });
      }
      throw err;
    }
    const raw = parse(text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${boundId}" 的 module.yaml 不是映射（${file}）`,
      });
    }
    if (raw.format !== "toporealm.module/v2") {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${boundId}" 的 module.yaml 不是 toporealm.module/v2 格式（${file}）`,
        details: { module: boundId, format: String(raw.format) },
      });
    }
    for (const key of ["id", "namespace", "version", "entry"] as const) {
      if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `模块 "${boundId}" 的 module.yaml 缺少必填字段 "${key}"`,
          details: { module: boundId, field: key },
        });
      }
    }
    const id = raw.id as string;
    if (id !== boundId) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `modules.yaml 绑定键 "${boundId}" 与 module.yaml id "${id}" 不一致`,
        details: { boundId, manifestId: id },
      });
    }
    const manifest: ModuleManifestV2 = {
      format: "toporealm.module/v2",
      id,
      namespace: raw.namespace as string,
      version: raw.version as string,
      entry: raw.entry as string,
      ...(raw.requires !== undefined ? { requires: normRequires(raw.requires, boundId) } : {}),
      ...(raw.kinds !== undefined ? { kinds: normKinds(raw.kinds, boundId) } : {}),
      ...(raw.ui !== undefined && typeof raw.ui === "object" && raw.ui !== null
        ? { ui: raw.ui as ModuleManifestV2["ui"] }
        : {}),
    };
    return manifest;
  }

  private async activateModule(
    id: string,
    manifest: ModuleManifestV2,
    dir: string,
  ): Promise<void> {
    // 声明词汇（ns.name 全量集合）——目录投影与 M5 词汇偏差检查的基准
    const declaredKinds = new Set<Kind>();
    for (const name of manifest.kinds?.objects ?? []) {
      declaredKinds.add(`${manifest.namespace}.${name}`);
    }
    for (const name of manifest.kinds?.relations ?? []) {
      declaredKinds.add(`${manifest.namespace}.${name}`);
    }

    const m: LoadedModule = {
      id,
      namespace: manifest.namespace,
      version: manifest.version,
      manifest,
      dir,
      declaredKinds,
      frozen: false,
    };
    this.loaded.set(id, m);

    // 所有权法 id → namespace 注册（D20；先于 activate——activate 内的种子提交已受管辖）
    this.core.registerModuleOwner(id, manifest.namespace);

    const entryPath = path.resolve(dir, manifest.entry);
    let entry: ModuleEntryPoint;
    try {
      const mod = (await import(pathToFileURL(entryPath).href)) as {
        default?: unknown;
      };
      const d = mod?.default as ModuleEntryPoint | undefined;
      if (!d || typeof d.activate !== "function") {
        throw new Error("default export 缺少 activate 函数");
      }
      entry = d;
    } catch (err) {
      this.loaded.delete(id);
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${id}" 入口装载失败（${manifest.entry}）：${err instanceof Error ? err.message : String(err)}`,
        details: { module: id, entry: manifest.entry },
      });
    }

    try {
      await entry.activate(this.buildApi(m));
    } catch (err) {
      this.loaded.delete(id);
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${id}" activate 失败：${err instanceof Error ? err.message : String(err)}`,
        details: { module: id },
      });
    }
    m.frozen = true; // 注册面冻结（M1 不变量）
  }

  // ---------- ModuleApi（模块唯一运行时面，blueprint §1.2） ----------

  private buildApi(m: LoadedModule): ModuleApi {
    const self = Object.freeze({
      id: m.id,
      namespace: m.namespace,
      version: m.version,
    });
    return {
      self,
      read: (query) => this.core.read(query),
      get: (id: EntityId) => this.core.read({ ids: [id] }).entities[0],
      byKind: (kind: Kind) => [...this.core.read({ kinds: [kind] }).entities],
      commit: (input) => {
        // 所有权法执法点：以 module:<id> 身份提交（core 落执法；返回即已原子落盘）
        const r = this.core.commitSync(input, `module:${m.id}`);
        // D21 受理回执（fromRevision === toRevision，排队尚未执行）不算本命令的真实提交
        if (this.currentCommits && r.patch.toRevision > r.patch.fromRevision) {
          this.currentCommits.push(r);
        }
        return r;
      },
      command: (spec, handler) => this.registerCommand(m, spec, handler),
      hook: (name, fn) => {
        if (m.frozen) throw lateRegistration(m.id, `hook(${name})`);
        if (name === "before-commit") {
          this.core.registerBeforeCommitHook(fn as BeforeCommitHook);
        } else {
          this.core.registerAfterCommitHook(fn as AfterCommitHook);
        }
      },
      form: (kind, form) => {
        if (m.frozen) throw lateRegistration(m.id, `form(${kind})`);
        this.forms.set(kind, form); // 同 kind 重复注册 = 后者覆盖（声明层协调语义）
      },
    };
  }

  private registerCommand(
    m: LoadedModule,
    spec: CommandSpec,
    handler: CommandHandler,
  ): void {
    if (m.frozen) throw lateRegistration(m.id, `command(${spec.name})`);
    if (typeof spec.name !== "string" || !/^[^\s.]+$/.test(spec.name)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${m.id}" 注册的命令名非法："${String(spec.name)}"（不得含点号与空白；目录 id = ${m.namespace}.<name>）`,
        details: { module: m.id, name: spec.name },
      });
    }
    if (typeof spec.title !== "string" || spec.title.length === 0) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${m.id}" 的命令 "${spec.name}" 缺少 title（agent 的唯一文档，必填）`,
        details: { module: m.id, name: spec.name },
      });
    }
    if (spec.target !== undefined && !isValidKind(spec.target)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${m.id}" 的命令 "${spec.name}" target 非法："${String(spec.target)}"`,
        details: { module: m.id, name: spec.name },
      });
    }
    const id = `${m.namespace}.${spec.name}`;
    if (this.commands.has(id)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `命令 id 冲突："${id}" 已注册`,
        details: { commandId: id, module: m.id },
      });
    }
    this.commands.set(id, { moduleId: m.id, spec: { ...spec }, handler });
  }

  // ---------- 目录聚合（D12：目录永远等于注册事实） ----------

  catalog(module?: string): Catalog {
    const kinds = new Map<Kind, Catalog["kinds"][number]>();
    // 声明层投影优先（带 ui color/icon），活图 kind 兜底（core 聚合，owner 取命名空间前缀）
    for (const m of this.loaded.values()) {
      const ui = m.manifest.ui;
      for (const kind of m.declaredKinds) {
        kinds.set(kind, {
          kind,
          owner: m.namespace,
          ...(ui?.color !== undefined ? { color: ui.color } : {}),
          ...(ui?.icon !== undefined ? { icon: ui.icon } : {}),
        });
      }
    }
    for (const k of this.core.catalog().kinds) {
      if (!kinds.has(k.kind)) kinds.set(k.kind, k);
    }
    let commands: CatalogEntry[] = [...this.commands.entries()].map(
      ([id, c]) => ({
        id,
        module: c.moduleId,
        title: c.spec.title,
        ...(c.spec.target !== undefined ? { target: c.spec.target } : {}),
        ...(c.spec.input !== undefined ? { input: c.spec.input } : {}),
      }),
    );
    if (module !== undefined) {
      // --module 按模块 id 或 namespace 过滤（cli cmds [--module ns]）
      const ids = new Set(
        [...this.loaded.values()]
          .filter((m) => m.id === module || m.namespace === module)
          .map((m) => m.id),
      );
      commands = commands.filter((c) => ids.has(c.module));
    }
    return {
      modules: [...this.loaded.values()].map((m) => ({
        id: m.id,
        version: m.version,
        namespace: m.namespace,
      })),
      kinds: [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
      commands,
    };
  }

  // ---------- 命令分发（target 存在性 + appliesTo 兑现；schema 是说明书不是门禁） ----------

  async run(
    commandId: string,
    opts?: { target?: EntityId; input?: unknown },
  ): Promise<CommandRunResult> {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      throw new TopoError({
        code: "UNKNOWN_COMMAND",
        message: `未知命令 "${commandId}"`,
        hint: "目录自省：toporealm cmds",
        details: {
          commandId,
          suggestions: suggestClosest(commandId, [...this.commands.keys()]),
        },
      });
    }
    // 结构检查：input 必须是对象映射（JSON Schema 只写进目录作说明书，不作门禁——执法仅两条）
    let input = opts?.input;
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `命令 "${commandId}" 的 input 需要对象映射`,
        details: { commandId, input: opts?.input },
      });
    }
    // target 解析：存在性（UNKNOWN_ID + did-you-mean）+ appliesTo 兑现（INVALID_INPUT）
    let target: EntityRecord | undefined;
    if (opts?.target !== undefined) {
      const rec = this.core.read({ ids: [opts.target] }).entities[0];
      if (!rec) {
        const candidates = this.core.read({ fields: ["id"] }).entities.map((e) => e.id);
        throw new TopoError({
          code: "UNKNOWN_ID",
          message: `命令目标不存在："${opts.target}"`,
          hint: candidates.length > 0 ? `是不是想用 "${suggestClosest(opts.target, candidates, 1)[0] ?? candidates[0]}"？` : undefined,
          details: { id: opts.target, suggestions: suggestClosest(opts.target, candidates) },
        });
      }
      if (cmd.spec.target !== undefined && rec.kind !== cmd.spec.target) {
        throw new TopoError({
          code: "INVALID_INPUT",
          message: `命令 "${commandId}" 应用于主类型 ${cmd.spec.target}，而目标 "${opts.target}" 是 ${rec.kind}`,
          hint: "appliesTo 不匹配；用 read 确认目标主类型，或换绑定的命令",
          details: { commandId, target: opts.target, targetKind: rec.kind, appliesTo: cmd.spec.target },
        });
      }
      target = rec;
    } else if (cmd.spec.target !== undefined) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `命令 "${commandId}" 应用于主类型 ${cmd.spec.target}，需要提供 target`,
        details: { commandId, appliesTo: cmd.spec.target },
      });
    }

    const commits: CommitResult[] = [];
    this.currentCommits = commits;
    let out: CommandOutput;
    try {
      out = (await cmd.handler({
        ...(target !== undefined ? { target } : {}),
        input: input as Record<string, unknown>,
      })) as CommandOutput;
    } finally {
      this.currentCommits = null;
    }
    return {
      ...(out?.message !== undefined ? { message: out.message } : {}),
      ...(out?.data !== undefined ? { data: out.data } : {}),
      ...(commits.length > 0 ? { commits } : {}),
    };
  }

  // ---------- M5：声明词汇 vs 实际写入（目录级一致性；记 warning，不执法——D8） ----------

  private installVocabularyObserver(): void {
    this.core.registerAfterCommitHook((e) => {
      if (!e.origin.startsWith("module:")) return;
      const moduleId = e.origin.slice("module:".length);
      const m = this.loaded.get(moduleId);
      if (!m) return;
      const written = [
        ...e.patch.objects.added,
        ...e.patch.objects.updated,
        ...e.patch.relations.added,
        ...e.patch.relations.updated,
      ];
      for (const rec of written) {
        if (kindNamespace(rec.kind) !== m.namespace) continue; // 跨命名空间归所有权法管
        if (m.declaredKinds.has(rec.kind)) continue;
        const key = `${moduleId}:${rec.kind}`;
        if (this.warnedVocabulary.has(key)) continue;
        this.warnedVocabulary.add(key);
        this.warn(
          `模块 "${moduleId}" 写入了未声明的主类型 "${rec.kind}"（目录外行为；声明层不执法——D8，仅记 warning）`,
        );
      }
    });
  }
}

// ---------- 纯辅助 ----------

function lateRegistration(moduleId: string, what: string): TopoError {
  return new TopoError({
    code: "LATE_REGISTRATION",
    message: `模块 "${moduleId}" 在 activate 返回后注册 ${what}（注册面已冻结）`,
    hint: "注册必须发生在 activate 内；返回后的目录变化会破坏「目录永远为真」",
    details: { module: moduleId, what },
  });
}

function normRequires(
  raw: unknown,
  moduleId: string,
): { modules: readonly string[] } {
  const r = raw as { modules?: unknown };
  if (r.modules !== undefined && !Array.isArray(r.modules)) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块 "${moduleId}" 的 requires.modules 必须是字符串数组`,
    });
  }
  return {
    modules: (r.modules ?? []).map(String),
  };
}

function normKinds(
  raw: unknown,
  moduleId: string,
): { objects?: readonly string[]; relations?: readonly string[] } {
  const k = raw as { objects?: unknown; relations?: unknown };
  const norm = (v: unknown, field: string): readonly string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      throw new TopoError({
        code: "INVALID_INPUT",
        message: `模块 "${moduleId}" 的 kinds.${field} 必须是字符串数组`,
      });
    }
    return v.map(String);
  };
  return { objects: norm(k.objects, "objects"), relations: norm(k.relations, "relations") };
}

/** Kahn 拓扑排序；环 → 启动大声失败并点名环内模块。 */
function topoSort(
  resolved: Map<string, { manifest: ModuleManifestV2 }>,
): string[] {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of resolved.keys()) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const [id, { manifest }] of resolved) {
    for (const r of manifest.requires?.modules ?? []) {
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
      dependents.get(r)?.push(id);
    }
  }
  const ready = [...resolved.keys()].filter((id) => indeg.get(id) === 0).sort();
  const order: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i] as string;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (order.length !== resolved.size) {
    const cycle = [...resolved.keys()].filter((id) => !order.includes(id));
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `模块依赖循环：${cycle.join(" → ")}`,
      details: { cycle },
    });
  }
  return order;
}
