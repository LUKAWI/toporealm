import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import * as YAML from "yaml";
import {
  GRAPH_FORMAT,
  type EntityId,
  type GraphManifest,
  type GraphPatch,
  type GraphSnapshot,
  type ManifestMutation,
  type Mutation,
  type MutationPlan,
  type MutationResult,
  type ObjectRecord,
  type RelationRecord,
} from "./types.js";
import { CoreError, GraphLockError, HistoryBoundaryError, RevisionConflictError } from "./errors.js";

interface HistoryEntry {
  before: GraphSnapshot;
  after: GraphSnapshot;
  label?: string;
}

interface HistoryState {
  entries: HistoryEntry[];
  cursor: number;
}

const OBJECTS_DIR = "objects";
const RELATIONS_DIR = "relations";
const MANIFEST_FILE = "graph.yaml";
const REVISION_FILE = ".revision.json";
const HISTORY_FILE = ".history.json";
const LOCK_FILE = ".lock";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSafeId(id: string, label: string): void {
  if (!id || id === "." || id === ".." || /[\\/:]/.test(id)) {
    throw new CoreError({ code: "INVALID_ID", message: `${label} ID 无效：${id}` });
  }
}

function parseYaml<T>(path: string): T {
  try {
    return YAML.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new CoreError({
      code: "INVALID_GRAPH_FILE",
      message: `无法读取图文件：${path}`,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  if (existsSync(path)) unlinkSync(path);
  renameSync(temporary, path);
}

function writeYamlAtomic(path: string, value: unknown): void {
  writeAtomic(path, YAML.stringify(value));
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new CoreError({
      code: "INVALID_GRAPH_STATE",
      message: `无法读取图状态：${path}`,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

function validateManifest(value: unknown, path: string): GraphManifest {
  if (!value || typeof value !== "object") {
    throw new CoreError({ code: "INVALID_MANIFEST", message: `图清单不是对象：${path}` });
  }
  const manifest = value as Partial<GraphManifest>;
  if (manifest.format !== GRAPH_FORMAT || typeof manifest.id !== "string") {
    throw new CoreError({
      code: "INVALID_MANIFEST",
      message: `图清单必须使用 ${GRAPH_FORMAT} 且包含 id：${path}`,
    });
  }
  assertSafeId(manifest.id, "图");
  if (!manifest.sources || typeof manifest.sources.objects !== "string" || typeof manifest.sources.relations !== "string") {
    throw new CoreError({ code: "INVALID_MANIFEST", message: `图清单缺少 sources：${path}` });
  }
  return clone(manifest as GraphManifest);
}

function validateObject(value: unknown, path: string): ObjectRecord {
  if (!value || typeof value !== "object") {
    throw new CoreError({ code: "INVALID_OBJECT", message: `对象记录不是对象：${path}` });
  }
  const object = value as Partial<ObjectRecord>;
  if (typeof object.id !== "string" || typeof object.kind !== "string" || typeof object.label !== "string") {
    throw new CoreError({ code: "INVALID_OBJECT", message: `对象记录缺少 id/kind/label：${path}` });
  }
  assertSafeId(object.id, "对象");
  return clone(object as ObjectRecord);
}

function validateRelation(value: unknown, path: string): RelationRecord {
  if (!value || typeof value !== "object") {
    throw new CoreError({ code: "INVALID_RELATION", message: `关系记录不是对象：${path}` });
  }
  const relation = value as Partial<RelationRecord>;
  if (
    typeof relation.id !== "string" ||
    typeof relation.kind !== "string" ||
    typeof relation.source !== "string" ||
    typeof relation.target !== "string" ||
    (relation.direction !== "directed" && relation.direction !== "undirected")
  ) {
    throw new CoreError({ code: "INVALID_RELATION", message: `关系记录缺少必需字段：${path}` });
  }
  assertSafeId(relation.id, "关系");
  assertSafeId(relation.source, "关系 source");
  assertSafeId(relation.target, "关系 target");
  return clone(relation as RelationRecord);
}

function recordMap<T extends { id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, clone(record)]));
}

function sortedRecords<T extends { id: string }>(records: Iterable<T>): T[] {
  return [...records].sort((left, right) => left.id.localeCompare(right.id));
}

export function diffSnapshots(before: GraphSnapshot, after: GraphSnapshot): GraphPatch {
  const beforeObjects = recordMap(before.objects);
  const afterObjects = recordMap(after.objects);
  const beforeRelations = recordMap(before.relations);
  const afterRelations = recordMap(after.relations);
  const addedObjects: ObjectRecord[] = [];
  const updatedObjects: ObjectRecord[] = [];
  const deletedObjects: EntityId[] = [];
  const addedRelations: RelationRecord[] = [];
  const updatedRelations: RelationRecord[] = [];
  const deletedRelations: EntityId[] = [];

  for (const [id, object] of afterObjects) {
    const previous = beforeObjects.get(id);
    if (!previous) addedObjects.push(object);
    else if (!jsonEqual(previous, object)) updatedObjects.push(object);
  }
  for (const id of beforeObjects.keys()) if (!afterObjects.has(id)) deletedObjects.push(id);
  for (const [id, relation] of afterRelations) {
    const previous = beforeRelations.get(id);
    if (!previous) addedRelations.push(relation);
    else if (!jsonEqual(previous, relation)) updatedRelations.push(relation);
  }
  for (const id of beforeRelations.keys()) if (!afterRelations.has(id)) deletedRelations.push(id);

  const patch: GraphPatch = {
    fromRevision: before.revision,
    toRevision: after.revision,
    objects: {
      added: sortedRecords(addedObjects),
      updated: sortedRecords(updatedObjects),
      deleted: deletedObjects.sort(),
    },
    relations: {
      added: sortedRecords(addedRelations),
      updated: sortedRecords(updatedRelations),
      deleted: deletedRelations.sort(),
    },
    manifestChanged: !jsonEqual(before.manifest, after.manifest),
  };
  if (patch.manifestChanged) patch.manifest = clone(after.manifest);
  return patch;
}

export class GraphStore {
  readonly graphRoot: string;

  constructor(graphRoot: string) {
    this.graphRoot = graphRoot;
  }

  static fromWorkspace(workspaceRoot: string, graphId: string): GraphStore {
    assertSafeId(graphId, "图");
    return new GraphStore(join(workspaceRoot, ".toporealm", "graphs", graphId));
  }

  initialize(manifest: GraphManifest): GraphSnapshot {
    const checked = validateManifest(manifest, join(this.graphRoot, MANIFEST_FILE));
    mkdirSync(join(this.graphRoot, OBJECTS_DIR), { recursive: true });
    mkdirSync(join(this.graphRoot, RELATIONS_DIR), { recursive: true });
    if (existsSync(join(this.graphRoot, MANIFEST_FILE))) return this.read();
    const snapshot: GraphSnapshot = { manifest: checked, objects: [], relations: [], revision: 0 };
    this.writeSnapshot(snapshot);
    this.writeHistory({ entries: [], cursor: 0 });
    return snapshot;
  }

  read(): GraphSnapshot {
    const manifestPath = join(this.graphRoot, MANIFEST_FILE);
    if (!existsSync(manifestPath)) {
      throw new CoreError({ code: "GRAPH_NOT_FOUND", message: `找不到图清单：${manifestPath}` });
    }
    const manifest = validateManifest(parseYaml<unknown>(manifestPath), manifestPath);
    const objects = this.readRecords<ObjectRecord>(OBJECTS_DIR, validateObject);
    const relations = this.readRecords<RelationRecord>(RELATIONS_DIR, validateRelation);
    const revisionState = readJson<{ revision?: number }>(join(this.graphRoot, REVISION_FILE), { revision: 0 });
    const revision = Number.isInteger(revisionState.revision) && (revisionState.revision as number) >= 0 ? (revisionState.revision as number) : 0;
    return { manifest, objects, relations, revision };
  }

  apply(plan: MutationPlan): MutationResult {
    return this.withLock(() => {
      const before = this.read();
      if (plan.expectedRevision !== undefined && plan.expectedRevision !== before.revision) {
        throw new RevisionConflictError(plan.expectedRevision, before.revision);
      }
      if (plan.mutations.length === 0) return this.result(before, before);
      const changed = this.applyMutations(before, plan.mutations);
      const after: GraphSnapshot = { ...changed, revision: before.revision + 1 };
      this.writeSnapshot(after);
      const history = this.readHistory();
      const entries = history.entries.slice(0, history.cursor);
      const entry: HistoryEntry = { before: clone(before), after: clone(after) };
      if (plan.label !== undefined) entry.label = plan.label;
      entries.push(entry);
      this.writeHistory({ entries, cursor: entries.length });
      return this.result(before, after, { entries, cursor: entries.length });
    });
  }

  undo(expectedRevision?: number): MutationResult {
    return this.withLock(() => {
      const current = this.read();
      this.assertExpectedRevision(expectedRevision, current.revision);
      const history = this.readHistory();
      if (history.cursor === 0) throw new HistoryBoundaryError("undo");
      const entry = history.entries[history.cursor - 1];
      if (!entry) throw new HistoryBoundaryError("undo");
      const restored: GraphSnapshot = { ...clone(entry.before), revision: current.revision + 1 };
      this.writeSnapshot(restored);
      const nextHistory = { entries: history.entries, cursor: history.cursor - 1 };
      this.writeHistory(nextHistory);
      return this.result(current, restored, nextHistory);
    });
  }

  redo(expectedRevision?: number): MutationResult {
    return this.withLock(() => {
      const current = this.read();
      this.assertExpectedRevision(expectedRevision, current.revision);
      const history = this.readHistory();
      if (history.cursor >= history.entries.length) throw new HistoryBoundaryError("redo");
      const entry = history.entries[history.cursor];
      if (!entry) throw new HistoryBoundaryError("redo");
      const restored: GraphSnapshot = { ...clone(entry.after), revision: current.revision + 1 };
      this.writeSnapshot(restored);
      const nextHistory = { entries: history.entries, cursor: history.cursor + 1 };
      this.writeHistory(nextHistory);
      return this.result(current, restored, nextHistory);
    });
  }

  historyStatus(): { canUndo: boolean; canRedo: boolean } {
    const state = this.readHistory();
    return { canUndo: state.cursor > 0, canRedo: state.cursor < state.entries.length };
  }

  private result(before: GraphSnapshot, after: GraphSnapshot, history = this.readHistory()): MutationResult {
    return {
      snapshot: clone(after),
      patch: diffSnapshots(before, after),
      history: { canUndo: history.cursor > 0, canRedo: history.cursor < history.entries.length },
    };
  }

  private assertExpectedRevision(expectedRevision: number | undefined, actualRevision: number): void {
    if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
      throw new RevisionConflictError(expectedRevision, actualRevision);
    }
  }

  private applyMutations(snapshot: GraphSnapshot, mutations: readonly Mutation[]): GraphSnapshot {
    const objects = recordMap(snapshot.objects);
    const relations = recordMap(snapshot.relations);
    let manifest = clone(snapshot.manifest);
    for (const mutation of mutations) {
      switch (mutation.op) {
        case "upsert_object": {
          const object = validateObject(mutation.object, "mutation.object");
          objects.set(object.id, object);
          break;
        }
        case "delete_object": {
          assertSafeId(mutation.id, "对象");
          objects.delete(mutation.id);
          for (const [id, relation] of relations) {
            if (relation.source === mutation.id || relation.target === mutation.id) relations.delete(id);
          }
          break;
        }
        case "upsert_relation": {
          const relation = validateRelation(mutation.relation, "mutation.relation");
          relations.set(relation.id, relation);
          break;
        }
        case "delete_relation":
          assertSafeId(mutation.id, "关系");
          relations.delete(mutation.id);
          break;
        case "patch_manifest":
          manifest = this.patchManifest(manifest, mutation);
          break;
      }
    }
    for (const relation of relations.values()) {
      if (!objects.has(relation.source) || !objects.has(relation.target)) {
        throw new CoreError({
          code: "DANGLING_RELATION",
          message: `关系 ${relation.id} 引用了不存在的对象。`,
          details: { source: relation.source, target: relation.target },
        });
      }
    }
    return { manifest, objects: sortedRecords(objects.values()), relations: sortedRecords(relations.values()), revision: snapshot.revision };
  }

  private patchManifest(manifest: GraphManifest, mutation: ManifestMutation): GraphManifest {
    const patch = mutation.patch;
    const next: GraphManifest = { ...clone(manifest) };
    if (patch.label !== undefined) next.label = patch.label;
    if (patch.modules !== undefined) next.modules = clone(patch.modules);
    if (patch.meta !== undefined) next.meta = { ...(manifest.meta ?? {}), ...clone(patch.meta) };
    return next;
  }

  private readRecords<T extends { id: string }>(directory: string, validator: (value: unknown, path: string) => T): T[] {
    const path = join(this.graphRoot, directory);
    if (!existsSync(path)) return [];
    const files = readdirSync(path).filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"));
    return sortedRecords(files.map((file) => validator(parseYaml<unknown>(join(path, file)), join(path, file))));
  }

  private writeSnapshot(snapshot: GraphSnapshot): void {
    mkdirSync(join(this.graphRoot, OBJECTS_DIR), { recursive: true });
    mkdirSync(join(this.graphRoot, RELATIONS_DIR), { recursive: true });
    writeYamlAtomic(join(this.graphRoot, MANIFEST_FILE), snapshot.manifest);
    this.writeRecords(OBJECTS_DIR, snapshot.objects);
    this.writeRecords(RELATIONS_DIR, snapshot.relations);
    writeAtomic(join(this.graphRoot, REVISION_FILE), JSON.stringify({ revision: snapshot.revision }, null, 2));
  }

  private writeRecords<T extends { id: string }>(directory: string, records: readonly T[]): void {
    const path = join(this.graphRoot, directory);
    const expected = new Set(records.map((record) => `${record.id}.yaml`));
    for (const file of readdirSync(path).filter((item) => item.endsWith(".yaml") || item.endsWith(".yml"))) {
      if (!expected.has(file)) unlinkSync(join(path, file));
    }
    for (const record of records) writeYamlAtomic(join(path, `${record.id}.yaml`), record);
  }

  private readHistory(): HistoryState {
    const fallback: HistoryState = { entries: [], cursor: 0 };
    const state = readJson<HistoryState>(join(this.graphRoot, HISTORY_FILE), fallback);
    if (!Array.isArray(state.entries) || !Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > state.entries.length) return fallback;
    return state;
  }

  private writeHistory(state: HistoryState): void {
    writeAtomic(join(this.graphRoot, HISTORY_FILE), JSON.stringify(state, null, 2));
  }

  private withLock<T>(action: () => T): T {
    mkdirSync(this.graphRoot, { recursive: true });
    const lockPath = join(this.graphRoot, LOCK_FILE);
    let descriptor: number;
    try {
      descriptor = openSync(lockPath, "wx");
    } catch {
      throw new GraphLockError(lockPath);
    }
    try {
      return action();
    } finally {
      closeSync(descriptor);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  }
}
