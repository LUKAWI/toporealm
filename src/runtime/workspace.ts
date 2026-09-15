import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createManagedGraph, initializeManagedGraph, type ManagedGraph, type ManagedValidatorRef } from "../core/managed.js";
import { GraphStore } from "../core/store.js";
import type { GraphManifest, GraphSnapshot } from "../core/types.js";
import { CoreError } from "../core/errors.js";
import {
  GraphActivator,
  WorkspaceModuleResolver,
  type AvailableModule,
  type GraphRegistrySnapshot,
} from "../module-sdk/registry.js";
import {
  compileModulePrivateSchema,
  loadModuleRuntime,
  type CompiledModulePrivateSchema,
  type ModuleRuntime,
} from "../module-sdk/runtime.js";
import { ActionExecutor } from "../module-sdk/actions.js";

export interface WorkspaceRuntimeOptions {
  readonly workspaceRoot: string;
  readonly graphId: string;
  readonly globalHome?: string;
  readonly runtimes?: Readonly<Record<string, ModuleRuntime>>;
}

export interface WorkspaceRuntime {
  readonly workspaceRoot: string;
  readonly graphId: string;
  readonly registry: Readonly<GraphRegistrySnapshot>;
  readonly graph: ManagedGraph;
  readonly runtimes: Readonly<Record<string, ModuleRuntime>>;
  readonly actions: ActionExecutor;
  readonly moduleRoots: Readonly<Record<string, string>>;
  historyStatus(): { canUndo: boolean; canRedo: boolean };
}

/** Shared composition root used by CLI, MCP, Server and Web adapters. */
export async function createWorkspaceRuntime(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
  const prepared = prepareWorkspaceRuntime(options);
  const runtimes: Record<string, ModuleRuntime> = { ...(options.runtimes ?? {}) };
  for (const module of prepared.available.values()) {
    if (!runtimes[module.id] && module.manifest.runtime?.entry) runtimes[module.id] = await loadModuleRuntime(module.root, module.manifest.runtime.entry, module.id);
  }
  return composeWorkspaceRuntime(prepared, runtimes);
}

/** Sync adapter seam for hosts that inject already-loaded module runtimes. */
export function createWorkspaceRuntimeSync(options: WorkspaceRuntimeOptions): WorkspaceRuntime {
  const prepared = prepareWorkspaceRuntime(options);
  return composeWorkspaceRuntime(prepared, options.runtimes ?? {});
}

function prepareWorkspaceRuntime(options: WorkspaceRuntimeOptions) {
  const workspaceRoot = resolve(options.workspaceRoot);
  const store = GraphStore.fromWorkspace(workspaceRoot, options.graphId);
  const snapshot = store.read();
  const resolver = new WorkspaceModuleResolver(workspaceRoot, options.globalHome === undefined ? {} : { globalHome: options.globalHome });
  const registry = new GraphActivator(resolver).activate(snapshot);
  const available = new Map<string, AvailableModule>();
  for (const status of registry.modules) {
    if (status.status !== "available") continue;
    const module = resolver.resolve(status.id);
    if (module.status === "available") available.set(status.id, module);
  }
  return { workspaceRoot, graphId: options.graphId, store, registry, available };
}

function composeWorkspaceRuntime(prepared: ReturnType<typeof prepareWorkspaceRuntime>, supplied: Readonly<Record<string, ModuleRuntime>>): WorkspaceRuntime {
  const runtimes = Object.freeze({ ...supplied });
  const { workspaceRoot, graphId, store, registry } = prepared;
  const schemas = compileSchemas(registry);
  const validators = compileValidators(registry);
  const graph = createManagedGraph(store, { registry, schemas, validators, runtimes });
  const moduleRoots = Object.freeze(Object.fromEntries([...prepared.available].map(([id, module]) => [id, module.root])));
  return Object.freeze({ workspaceRoot, graphId, registry, graph, runtimes, moduleRoots, actions: new ActionExecutor(graph, registry, runtimes), historyStatus: () => store.historyStatus() });
}

export function listWorkspaceGraphs(workspaceRoot: string): Array<{ id: string; label?: string }> {
  const graphsRoot = join(resolve(workspaceRoot), ".toporealm", "graphs");
  if (!existsSync(graphsRoot)) return [];
  return readdirSync(graphsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(graphsRoot, entry.name, "graph.yaml"))).map((entry) => {
    const snapshot = GraphStore.fromWorkspace(workspaceRoot, entry.name).read();
    return snapshot.manifest.label === undefined ? { id: entry.name } : { id: entry.name, label: snapshot.manifest.label };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export function selectWorkspaceGraph(workspaceRoot: string, graphId: string): void {
  const manifest = join(resolve(workspaceRoot), ".toporealm", "graphs", graphId, "graph.yaml");
  if (!existsSync(manifest)) throw new CoreError({ code: "GRAPH_NOT_FOUND", message: `指定的图不存在：${graphId}` });
  writeFileSync(join(resolve(workspaceRoot), ".toporealm", "active"), `${graphId}\n`, "utf8");
}

export function initializeWorkspaceGraph(workspaceRoot: string, graphId: string, manifest: GraphManifest): GraphSnapshot {
  mkdirSync(join(resolve(workspaceRoot), ".toporealm", "graphs"), { recursive: true });
  return initializeManagedGraph(GraphStore.fromWorkspace(workspaceRoot, graphId), manifest).snapshot;
}

function compileSchemas(registry: GraphRegistrySnapshot): CompiledModulePrivateSchema[] {
  const schemas: CompiledModulePrivateSchema[] = [];
  for (const contribution of [...registry.objectKinds, ...registry.relationKinds]) {
    schemas.push(compileModulePrivateSchema({
      id: contribution.id,
      moduleId: contribution.moduleId,
      target: { area: "data", kind: contribution.fullId },
      declaration: contribution.declaration,
    }));
  }
  for (const contribution of registry.capabilities) {
    schemas.push(compileModulePrivateSchema({
      id: contribution.id,
      moduleId: contribution.moduleId,
      target: { area: "capabilities", capability: contribution.fullId },
      declaration: contribution.declaration,
    }));
  }
  return schemas;
}

function compileValidators(registry: GraphRegistrySnapshot): ManagedValidatorRef[] {
  const namespaces = new Map(registry.modules.map((module) => [module.id, module.namespace ?? module.id]));
  return registry.validators.flatMap((contribution) => {
    const declaration = contribution.declaration as { mode?: unknown } | undefined;
    if (declaration?.mode !== "snapshot" && declaration?.mode !== "transition") return [];
    return [{ id: contribution.id, moduleId: contribution.moduleId, namespace: namespaces.get(contribution.moduleId) ?? contribution.moduleId, mode: declaration.mode }];
  });
}
