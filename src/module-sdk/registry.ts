import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as YAML from "yaml";
import { CoreError, GraphStore } from "../core/index.js";
import type { GraphSnapshot, MutationPlan } from "../core/index.js";
import type { ContributionRef, ModuleDependency, ModuleFormat, ModuleManifest } from "./index.js";

export type ModuleSource = "global" | "workspace" | "path";

export interface ModuleBinding {
  source: ModuleSource;
  path?: string;
  version?: string;
}

export interface ModuleBindingsFile {
  bindings?: Record<string, ModuleBinding>;
}

export interface AvailableModule {
  status: "available";
  id: string;
  source: ModuleSource;
  root: string;
  manifest: ModuleManifest;
}

export interface UnavailableModule {
  status: "unavailable";
  id: string;
  source?: ModuleSource;
  root?: string;
  reason: string;
}

export type ResolvedModule = AvailableModule | UnavailableModule;

export interface WorkspaceModuleResolverOptions {
  globalHome?: string;
}

export interface RegisteredContribution {
  id: string;
  fullId: string;
  moduleId: string;
  declaration?: unknown;
}

export interface ModuleStatus {
  id: string;
  namespace?: string;
  status: "available" | "unavailable";
  source?: ModuleSource;
  version?: string;
  reason?: string;
}

export interface GraphRegistrySnapshot {
  registryRevision: number;
  modules: readonly ModuleStatus[];
  objectKinds: readonly RegisteredContribution[];
  relationKinds: readonly RegisteredContribution[];
  capabilities: readonly RegisteredContribution[];
  validators: readonly RegisteredContribution[];
  operations: readonly RegisteredContribution[];
  ui: Readonly<Record<string, unknown>>;
}

export interface ActionReference {
  operation: string;
  registryRevision: number;
  target?: string;
  inputSchema?: string;
  inputTemplate?: unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

function safeId(id: string): boolean {
  return Boolean(id) && id !== "." && id !== ".." && !/[\\/:]/.test(id);
}

function parseFile<T>(path: string): T {
  try {
    return YAML.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new CoreError({
      code: "INVALID_MODULE_FILE",
      message: `无法读取模块文件：${path}`,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function validateManifest(value: unknown, path: string): ModuleManifest {
  if (!value || typeof value !== "object") throw new CoreError({ code: "INVALID_MODULE_MANIFEST", message: `模块清单不是对象：${path}` });
  const manifest = value as Partial<ModuleManifest>;
  if (
    manifest.format !== ("toporealm.module/v1alpha1" as ModuleFormat) ||
    typeof manifest.id !== "string" ||
    typeof manifest.namespace !== "string" ||
    typeof manifest.version !== "string" ||
    !manifest.supports ||
    !Array.isArray(manifest.supports.schemas)
  ) {
    throw new CoreError({ code: "INVALID_MODULE_MANIFEST", message: `模块清单缺少身份或 supports.schemas：${path}` });
  }
  if (!safeId(manifest.id) || !safeId(manifest.namespace)) throw new CoreError({ code: "INVALID_MODULE_MANIFEST", message: `模块 id/namespace 无效：${path}` });
  return clone(manifest as ModuleManifest);
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

export function satisfiesVersion(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual || !range.trim()) return false;
  for (const token of range.trim().split(/\s+/)) {
    const match = /^(>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)/.exec(token);
    if (!match) continue;
    const expected = parseVersion(`${match[2]}.0`);
    if (!expected) return false;
    const comparison = compareVersion(actual, expected);
    const operator = match[1] ?? "=";
    if (operator === ">=" && comparison < 0) return false;
    if (operator === ">" && comparison <= 0) return false;
    if (operator === "<=" && comparison > 0) return false;
    if (operator === "<" && comparison >= 0) return false;
    if (operator === "=" && comparison !== 0) return false;
  }
  return true;
}

export class WorkspaceModuleResolver {
  readonly workspaceRoot: string;
  readonly globalHome: string;

  constructor(workspaceRoot: string, options: WorkspaceModuleResolverOptions = {}) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.globalHome = resolve(options.globalHome ?? process.env.TOPOREALM_HOME ?? join(homedir(), ".toporealm"));
  }

  readBindings(): ModuleBindingsFile {
    const path = join(this.workspaceRoot, ".toporealm", "modules.yaml");
    if (!existsSync(path)) return { bindings: {} };
    const parsed = parseFile<ModuleBindingsFile>(path);
    return parsed && typeof parsed === "object" && parsed.bindings ? parsed : { bindings: {} };
  }

  resolve(moduleId: string): ResolvedModule {
    const binding = this.readBindings().bindings?.[moduleId];
    if (!binding) return { status: "unavailable", id: moduleId, reason: "工作区没有显式模块绑定。" };
    let root: string;
    try {
      if (binding.source === "global") {
        if (!binding.version) return { status: "unavailable", id: moduleId, source: binding.source, reason: "global 绑定缺少准确 version。" };
        root = join(this.globalHome, "modules", moduleId, binding.version);
      } else {
        if (!binding.path) return { status: "unavailable", id: moduleId, source: binding.source, reason: `${binding.source} 绑定缺少 path。` };
        root = binding.source === "workspace" || !isAbsolute(binding.path)
          ? resolve(join(this.workspaceRoot, ".toporealm", binding.path))
          : resolve(binding.path);
      }
    } catch (error) {
      return { status: "unavailable", id: moduleId, source: binding.source, reason: error instanceof Error ? error.message : String(error) };
    }
    const manifestPath = join(root, "module.yaml");
    if (!existsSync(manifestPath)) return { status: "unavailable", id: moduleId, source: binding.source, root, reason: `找不到 module.yaml：${manifestPath}` };
    try {
      const manifest = validateManifest(parseFile<unknown>(manifestPath), manifestPath);
      if (manifest.id !== moduleId) return { status: "unavailable", id: moduleId, source: binding.source, root, reason: `模块清单 id=${manifest.id} 与绑定 ${moduleId} 不一致。` };
      if (binding.version && manifest.version !== binding.version) return { status: "unavailable", id: moduleId, source: binding.source, root, reason: `绑定版本 ${binding.version} 与清单版本 ${manifest.version} 不一致。` };
      return { status: "available", id: moduleId, source: binding.source, root, manifest };
    } catch (error) {
      return { status: "unavailable", id: moduleId, source: binding.source, root, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  resolveMany(moduleIds: readonly string[]): readonly ResolvedModule[] {
    return moduleIds.map((id) => this.resolve(id));
  }
}

export class GraphActivator {
  constructor(private readonly resolver: WorkspaceModuleResolver) {}

  activate(graph: GraphSnapshot): Readonly<GraphRegistrySnapshot> {
    const refs = graph.manifest.modules ?? [];
    const resolved = new Map(refs.map((ref) => [ref.id, this.resolver.resolve(ref.id)]));
    const modules: ModuleStatus[] = [];
    const objectKinds: RegisteredContribution[] = [];
    const relationKinds: RegisteredContribution[] = [];
    const capabilities: RegisteredContribution[] = [];
    const validators: RegisteredContribution[] = [];
    const operations: RegisteredContribution[] = [];
    const ui: Record<string, unknown> = {};

    for (const ref of refs) {
      const candidate = resolved.get(ref.id);
      if (!candidate || candidate.status === "unavailable") {
        modules.push({ id: ref.id, namespace: ref.namespace, status: "unavailable", reason: candidate?.reason ?? "模块解析失败。" });
        continue;
      }
      let reason: string | undefined;
      if (candidate.manifest.namespace !== ref.namespace) reason = `命名空间不匹配：图声明 ${ref.namespace}，模块声明 ${candidate.manifest.namespace}。`;
      else if (!candidate.manifest.supports.schemas.includes(ref.schema)) reason = `模块不支持图模式 ${ref.schema}。`;
      if (!reason) {
        for (const dependency of candidate.manifest.requires?.modules ?? []) {
          const dependencyRef = refs.find((item) => item.id === dependency.id);
          const dependencyModule = resolved.get(dependency.id);
          if (!dependencyRef || !dependencyModule || dependencyModule.status === "unavailable") {
            reason = `硬依赖 ${dependency.id} 未在图中可用。`;
            break;
          }
          if (!satisfiesVersion(dependencyModule.manifest.version, dependency.version)) {
            reason = `硬依赖 ${dependency.id}@${dependencyModule.manifest.version} 不满足 ${dependency.version}。`;
            break;
          }
        }
      }
      if (reason) {
        modules.push({ id: ref.id, namespace: ref.namespace, status: "unavailable", source: candidate.source, version: candidate.manifest.version, reason });
        continue;
      }
      try {
        const contributions = this.readContributions(candidate);
        objectKinds.push(...contributions.objectKinds);
        relationKinds.push(...contributions.relationKinds);
        capabilities.push(...contributions.capabilities);
        validators.push(...contributions.validators);
        operations.push(...contributions.operations);
        if (contributions.ui !== undefined) ui[candidate.manifest.id] = contributions.ui;
        const status: ModuleStatus = { id: ref.id, namespace: ref.namespace, status: "available", source: candidate.source, version: candidate.manifest.version };
        modules.push(status);
      } catch (error) {
        modules.push({ id: ref.id, namespace: ref.namespace, status: "unavailable", source: candidate.source, version: candidate.manifest.version, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return deepFreeze({
      registryRevision: graph.revision,
      modules,
      objectKinds,
      relationKinds,
      capabilities,
      validators,
      operations,
      ui,
    });
  }

  private readContributions(module: AvailableModule): {
    objectKinds: RegisteredContribution[];
    relationKinds: RegisteredContribution[];
    capabilities: RegisteredContribution[];
    validators: RegisteredContribution[];
    operations: RegisteredContribution[];
    ui?: unknown;
  } {
    const contributes = module.manifest.contributes ?? {};
    const readRefs = (refs: readonly ContributionRef[] | undefined): RegisteredContribution[] =>
      (refs ?? []).map((ref) => {
        if (!ref.id || !ref.declaration) throw new CoreError({ code: "INVALID_MODULE_CONTRIBUTION", message: `模块 ${module.id} 的贡献 ${ref.id} 缺少 declaration。` });
        const path = this.modulePath(module.root, ref.declaration);
        if (!existsSync(path)) throw new CoreError({ code: "INVALID_MODULE_CONTRIBUTION", message: `找不到模块贡献文件：${path}` });
        const value = parseFile<unknown>(path);
        const contribution: RegisteredContribution = { id: ref.id, fullId: `${module.manifest.namespace}.${ref.id}`, moduleId: module.id };
        contribution.declaration = value;
        return contribution;
      });
    let ui: unknown;
    if (module.manifest.ui?.contribution) {
      const path = this.modulePath(module.root, module.manifest.ui.contribution);
      if (!existsSync(path)) throw new CoreError({ code: "INVALID_MODULE_UI", message: `找不到模块 UI 贡献：${path}` });
      ui = parseFile<unknown>(path);
    }
    return {
      objectKinds: readRefs(contributes.object_kinds),
      relationKinds: readRefs(contributes.relation_kinds),
      capabilities: readRefs(contributes.capabilities),
      validators: readRefs(contributes.validators),
      operations: readRefs(contributes.operations),
      ui,
    };
  }

  private modulePath(root: string, relativePath: string): string {
    const path = resolve(root, relativePath);
    const escaped = relative(root, path).startsWith("..") || isAbsolute(relative(root, path));
    if (escaped) throw new CoreError({ code: "MODULE_PATH_ESCAPE", message: `模块路径越出模块目录：${relativePath}` });
    return path;
  }
}

export function discoverActions(registry: GraphRegistrySnapshot, target?: string): readonly ActionReference[] {
  return registry.operations.map((operation) => {
    const declaration = operation.declaration && typeof operation.declaration === "object" ? operation.declaration as Record<string, unknown> : {};
    const reference: ActionReference = { operation: operation.fullId, registryRevision: registry.registryRevision };
    if (target !== undefined) reference.target = target;
    if (typeof declaration.input_schema === "string") reference.inputSchema = declaration.input_schema;
    if (declaration.input_template !== undefined) reference.inputTemplate = clone(declaration.input_template);
    return reference;
  });
}

function moduleForKind(kind: string): string | undefined {
  const separator = kind.indexOf(".");
  return separator > 0 ? kind.slice(0, separator) : undefined;
}

export function validateMutationPlan(registry: GraphRegistrySnapshot, plan: MutationPlan): void {
  const statuses = new Map<string, ModuleStatus>();
  for (const module of registry.modules) {
    statuses.set(module.id, module);
    if (module.namespace) statuses.set(module.namespace, module);
  }
  for (const mutation of plan.mutations) {
    const kind = mutation.op === "upsert_object" ? mutation.object.kind : mutation.op === "upsert_relation" ? mutation.relation.kind : undefined;
    const moduleId = kind ? moduleForKind(kind) : undefined;
    if (!moduleId) continue;
    const module = statuses.get(moduleId);
    if (!module || module.status !== "available") {
      throw new CoreError({ code: "MODULE_UNAVAILABLE", message: `无法编辑 ${kind}：所属模块不可用。`, details: { moduleId } });
    }
    const contributions = mutation.op === "upsert_object" ? registry.objectKinds : registry.relationKinds;
    if (!contributions.some((contribution) => contribution.fullId === kind)) {
      throw new CoreError({ code: "CONTRIBUTION_NOT_FOUND", message: `模块已加载，但没有登记贡献 ${kind}。`, details: { moduleId, kind } });
    }
  }
}

export function applyRegisteredPlan(store: GraphStore, registry: GraphRegistrySnapshot, plan: MutationPlan) {
  validateMutationPlan(registry, plan);
  return store.apply(plan);
}
