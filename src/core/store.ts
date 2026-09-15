import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
import { CoreError, HistoryBoundaryError, RevisionConflictError } from "./errors.js";
import { RecoverableGraphPersistence, type DurableFileChange, type RecoverableCommit } from "./recoverable.js";

interface HistoryEntry {
  before: GraphSnapshot;
  after: GraphSnapshot;
  label?: string;
}

interface HistoryState {
  entries: HistoryEntry[];
  cursor: number;
  segmentId: string;
  baseRevision: number;
  baseline: GraphSnapshot;
  sealedSegments: string[];
  sealed?: boolean;
  previousSealed?: HistoryState;
}

export interface StoreNotice {
  readonly code: "EXTERNAL_EDIT_ABSORBED";
  readonly message: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly segmentId: string;
  readonly redoCleared: true;
  readonly auditPreserved: true;
  readonly preserved: true;
  readonly complete: boolean;
  readonly missingModules: readonly string[];
}

export type StoreMutationCommand =
  | { readonly kind: "commit"; readonly plan: MutationPlan }
  | { readonly kind: "undo"; readonly expectedRevision?: number }
  | { readonly kind: "redo"; readonly expectedRevision?: number };

type StoreInitializationCommand = { readonly kind: "initialize" };

export interface StoreTransition {
  readonly before: GraphSnapshot;
  readonly candidate: GraphSnapshot;
  readonly patch: GraphPatch;
}

const OBJECTS_DIR = "objects";
const RELATIONS_DIR = "relations";
const MANIFEST_FILE = "graph.yaml";
const REVISION_FILE = ".revision.json";
const HISTORY_FILE = ".history.json";
const HISTORY_INDEX_FILE = ".history/index.json";
const HISTORY_SEGMENTS_DIR = ".history/segments";
const AUDIT_FILE = ".audit.jsonl";

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
    this.writeHistory({ entries: [], cursor: 0, segmentId: "seg_0001", baseRevision: 0, baseline: clone(snapshot), sealedSegments: [] });
    return snapshot;
  }

  /** Internal bootstrap seam used by ManagedGraph; production adapters must not call initialize(). */
  initializeManaged(manifest: GraphManifest, validate: (snapshot: GraphSnapshot) => void): GraphSnapshot {
    const checked = validateManifest(manifest, join(this.graphRoot, MANIFEST_FILE));
    return new RecoverableGraphPersistence(this.graphRoot).transaction(() => {
      if (existsSync(join(this.graphRoot, MANIFEST_FILE))) return { result: this.read() };
      const before: GraphSnapshot = { manifest: checked, objects: [], relations: [], revision: -1 };
      const after: GraphSnapshot = { ...before, revision: 0 };
      validate(after);
      const history: HistoryState = {
        entries: [], cursor: 0, segmentId: "seg_0001", baseRevision: 0,
        baseline: clone(after), sealedSegments: [],
      };
      return {
        commit: this.createRecoverableCommit(`c_${randomUUID()}`, { kind: "initialize" }, before, after, history, history),
        result: clone(after),
      };
    });
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

  /** Internal ManagedGraph seam: recover and read while holding the graph lock. */
  readManaged<T>(action: (snapshot: GraphSnapshot, notice?: StoreNotice) => T, missingModules: readonly string[] = []): T {
    return new RecoverableGraphPersistence(this.graphRoot).transaction(() => {
      const observed = this.read();
      const external = this.externalState(observed);
      if (!external.changed) return { result: action(observed) };
      const current: GraphSnapshot = { ...observed, revision: external.baseRevision };
      const history = this.readHistory();
      const after: GraphSnapshot = { ...current, revision: current.revision + 1 };
      const segmentId = this.nextSegmentId(history);
      const sealed: HistoryState = { ...history, sealed: true };
      const nextHistory: HistoryState = {
        entries: [], cursor: 0, segmentId, baseRevision: after.revision,
        baseline: clone(after), sealedSegments: [...history.sealedSegments, history.segmentId],
        previousSealed: sealed,
      };
      const notice: StoreNotice = {
        code: "EXTERNAL_EDIT_ABSORBED", message: "已吸收图目录中的外部 YAML 修改。",
        fromRevision: current.revision, toRevision: after.revision, segmentId,
        redoCleared: true, auditPreserved: true, preserved: true,
        complete: missingModules.length === 0, missingModules: [...missingModules].sort(),
      };
      return {
        commit: this.createRecoverableCommit(`c_${randomUUID()}`, { kind: "external" }, current, after, history, nextHistory),
        result: action(after, notice),
      };
    });
  }

  /**
   * Core's single mutation pipeline. Candidate construction, validation and
   * recoverable persistence all happen under the same graph lock.
   */
  executeManaged(command: StoreMutationCommand, validate: (transition: StoreTransition) => void, missingModules: readonly string[] = []): MutationResult & { notice?: StoreNotice } {
    return new RecoverableGraphPersistence(this.graphRoot).transaction(() => {
      const observed = this.read();
      const external = this.externalState(observed);
      const before: GraphSnapshot = external.changed ? { ...observed, revision: external.baseRevision } : observed;
      const history = this.readHistory();
      if (external.changed) {
        const absorbed = this.prepareExternalAbsorption(before, history, missingModules);
        return {
          commit: this.createRecoverableCommit(`c_${randomUUID()}`, { kind: "external" }, before, absorbed.after, history, absorbed.history),
          result: { ...this.result(before, absorbed.after, absorbed.history), notice: absorbed.notice },
        };
      }
      const prepared = this.prepareTransition(command, before, history);
      validate({ before, candidate: prepared.after, patch: diffSnapshots(before, prepared.after) });
      const result = this.result(before, prepared.after, prepared.history);
      if (prepared.after.revision === before.revision) return { result };
      const commitId = `c_${randomUUID()}`;
      return {
        commit: this.createRecoverableCommit(commitId, command, before, prepared.after, history, prepared.history),
        result,
      };
    });
  }

  apply(plan: MutationPlan): MutationResult {
    return this.executeManaged({ kind: "commit", plan }, () => undefined);
  }

  undo(expectedRevision?: number): MutationResult {
    const command: StoreMutationCommand = expectedRevision === undefined ? { kind: "undo" } : { kind: "undo", expectedRevision };
    return this.executeManaged(command, () => undefined);
  }

  redo(expectedRevision?: number): MutationResult {
    const command: StoreMutationCommand = expectedRevision === undefined ? { kind: "redo" } : { kind: "redo", expectedRevision };
    return this.executeManaged(command, () => undefined);
  }

  historyStatus(): { canUndo: boolean; canRedo: boolean } {
    const state = this.readHistory();
    return { canUndo: state.cursor > 0, canRedo: state.cursor < state.entries.length };
  }

  private prepareTransition(command: StoreMutationCommand, before: GraphSnapshot, history: HistoryState): { after: GraphSnapshot; history: HistoryState } {
    if (command.kind === "commit") {
      this.assertExpectedRevision(command.plan.expectedRevision, before.revision);
      if (command.plan.mutations.length === 0) return { after: before, history };
      const changed = this.applyMutations(before, command.plan.mutations);
      const after: GraphSnapshot = { ...changed, revision: before.revision + 1 };
      const entries = history.entries.slice(0, history.cursor);
      const entry: HistoryEntry = { before: clone(before), after: clone(after) };
      if (command.plan.label !== undefined) entry.label = command.plan.label;
      entries.push(entry);
      return { after, history: { ...history, entries, cursor: entries.length } };
    }
    this.assertExpectedRevision(command.expectedRevision, before.revision);
    if (command.kind === "undo") {
      if (history.cursor === 0) throw new HistoryBoundaryError("undo");
      const entry = history.entries[history.cursor - 1];
      if (!entry) throw new HistoryBoundaryError("undo");
      return {
        after: { ...clone(entry.before), revision: before.revision + 1 },
        history: { ...history, entries: history.entries, cursor: history.cursor - 1 },
      };
    }
    if (history.cursor >= history.entries.length) throw new HistoryBoundaryError("redo");
    const entry = history.entries[history.cursor];
    if (!entry) throw new HistoryBoundaryError("redo");
    return {
      after: { ...clone(entry.after), revision: before.revision + 1 },
      history: { ...history, entries: history.entries, cursor: history.cursor + 1 },
    };
  }

  private prepareExternalAbsorption(before: GraphSnapshot, history: HistoryState, missingModules: readonly string[]): { after: GraphSnapshot; history: HistoryState; notice: StoreNotice } {
    const after: GraphSnapshot = { ...before, revision: before.revision + 1 };
    const segmentId = this.nextSegmentId(history);
    const sealed: HistoryState = { ...history, sealed: true };
    const nextHistory: HistoryState = {
      entries: [], cursor: 0, segmentId, baseRevision: after.revision,
      baseline: clone(after), sealedSegments: [...history.sealedSegments, history.segmentId], previousSealed: sealed,
    };
    return {
      after,
      history: nextHistory,
      notice: {
        code: "EXTERNAL_EDIT_ABSORBED", message: "已吸收图目录中的外部 YAML 修改。",
        fromRevision: before.revision, toRevision: after.revision, segmentId,
        redoCleared: true, auditPreserved: true, preserved: true,
        complete: missingModules.length === 0, missingModules: [...missingModules].sort(),
      },
    };
  }

  private createRecoverableCommit(
    commitId: string,
    command: StoreMutationCommand | StoreInitializationCommand | { readonly kind: "external" },
    before: GraphSnapshot,
    after: GraphSnapshot,
    beforeHistory: HistoryState,
    afterHistory: HistoryState,
  ): RecoverableCommit {
    const beforeFacts = this.factContents(before, true);
    const afterFacts = this.factContents(after, false, commitId);
    const files: DurableFileChange[] = [];
    for (const path of [...new Set([...beforeFacts.keys(), ...afterFacts.keys()])].sort()) {
      const oldValue = beforeFacts.get(path);
      const newValue = afterFacts.get(path);
      if (oldValue !== newValue) files.push(optionalChange(path, "fact", oldValue, newValue));
    }
    files.push(...this.historyChanges(beforeHistory, afterHistory));
    const auditPath = join(this.graphRoot, AUDIT_FILE);
    const oldAudit = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : undefined;
    const label = command.kind === "commit" ? command.plan.label ?? "提交变更" : command.kind === "undo" ? "[undo] 撤销" : command.kind === "redo" ? "[redo] 重做" : command.kind === "initialize" ? "初始化图" : "吸收外部编辑";
    const audit = {
      commitId,
      source: command.kind === "external" ? "external" : "core",
      fromRevision: before.revision,
      toRevision: after.revision,
      timestamp: new Date().toISOString(),
      label,
      checksumSummary: {
        algorithm: "digest:v1",
        before: snapshotDigest(before),
        after: snapshotDigest(after),
        fileCount: files.filter((item) => item.role === "fact").length,
      },
      recoveryStatus: command.kind === "external" ? "absorbed" : "committed",
    };
    files.push(optionalChange(AUDIT_FILE, "audit", oldAudit, `${oldAudit ?? ""}${JSON.stringify(audit)}\n`));
    return { commitId, baseRevision: before.revision, nextRevision: after.revision, files };
  }

  private factContents(snapshot: GraphSnapshot, preserveCurrentBytes: boolean, commitId?: string): Map<string, string | undefined> {
    const result = new Map<string, string | undefined>();
    const current = (path: string, fallback: string): string | undefined => {
      const absolute = join(this.graphRoot, path);
      if (preserveCurrentBytes) return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
      return fallback;
    };
    result.set(MANIFEST_FILE, current(MANIFEST_FILE, YAML.stringify(snapshot.manifest)));
    result.set(REVISION_FILE, current(REVISION_FILE, JSON.stringify(commitId ? { revision: snapshot.revision, commitId, snapshotDigest: snapshotDigest(snapshot) } : { revision: snapshot.revision }, null, 2)));
    const currentRecordPaths = (directory: string): string[] => {
      const absolute = join(this.graphRoot, directory);
      if (!existsSync(absolute)) return [];
      return readdirSync(absolute)
        .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
        .map((file) => `${directory}/${file}`);
    };
    if (preserveCurrentBytes) {
      for (const path of [...currentRecordPaths(OBJECTS_DIR), ...currentRecordPaths(RELATIONS_DIR)]) {
        result.set(path, readFileSync(join(this.graphRoot, path), "utf8"));
      }
    } else {
      for (const object of snapshot.objects) result.set(`${OBJECTS_DIR}/${object.id}.yaml`, YAML.stringify(object));
      for (const relation of snapshot.relations) result.set(`${RELATIONS_DIR}/${relation.id}.yaml`, YAML.stringify(relation));
    }
    return result;
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
    const entityIds = new Set<string>();
    for (const object of objects.values()) entityIds.add(object.id);
    for (const relation of relations.values()) {
      if (entityIds.has(relation.id)) throw new CoreError({ code: "DUPLICATE_ID", message: `对象和关系不能共享 ID：${relation.id}` });
      entityIds.add(relation.id);
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
    return sortedRecords(files.map((file) => {
      const recordPath = join(path, file);
      const record = validator(parseYaml<unknown>(recordPath), recordPath);
      const fileId = file.replace(/\.(yaml|yml)$/i, "");
      if (fileId !== record.id) throw new CoreError({ code: "FILE_ID_MISMATCH", message: `文件名 ${file} 与记录 ID ${record.id} 不一致。`, details: { path: recordPath } });
      return record;
    }));
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
    const current = this.read();
    const fallback: HistoryState = { entries: [], cursor: 0, segmentId: "seg_0001", baseRevision: current.revision, baseline: clone(current), sealedSegments: [] };
    const indexPath = join(this.graphRoot, HISTORY_INDEX_FILE);
    if (existsSync(indexPath)) {
      const index = readJson<{ currentSegment?: string; sealedSegments?: string[] }>(indexPath, {});
      if (index.currentSegment) {
        const segment = readJson<HistoryState>(join(this.graphRoot, HISTORY_SEGMENTS_DIR, `${index.currentSegment}.json`), fallback);
        if (Array.isArray(segment.entries) && Number.isInteger(segment.cursor) && segment.cursor >= 0 && segment.cursor <= segment.entries.length) {
          return { ...segment, segmentId: index.currentSegment, sealedSegments: Array.isArray(index.sealedSegments) ? index.sealedSegments : [] };
        }
      }
    }
    const legacy = readJson<Partial<HistoryState>>(join(this.graphRoot, HISTORY_FILE), fallback);
    if (!Array.isArray(legacy.entries) || !Number.isInteger(legacy.cursor) || (legacy.cursor ?? -1) < 0 || (legacy.cursor ?? 0) > legacy.entries.length) return fallback;
    return {
      entries: legacy.entries,
      cursor: legacy.cursor!,
      segmentId: legacy.segmentId ?? "seg_0001",
      baseRevision: legacy.baseRevision ?? legacy.entries[0]?.before.revision ?? current.revision,
      baseline: legacy.baseline ?? clone(legacy.entries[0]?.before ?? current),
      sealedSegments: legacy.sealedSegments ?? [],
    };
  }

  private writeHistory(state: HistoryState): void {
    mkdirSync(join(this.graphRoot, HISTORY_SEGMENTS_DIR), { recursive: true });
    writeAtomic(join(this.graphRoot, HISTORY_INDEX_FILE), JSON.stringify({ currentSegment: state.segmentId, sealedSegments: state.sealedSegments }, null, 2));
    writeAtomic(join(this.graphRoot, HISTORY_SEGMENTS_DIR, `${state.segmentId}.json`), JSON.stringify(this.serializableSegment(state), null, 2));
  }

  private historyChanges(before: HistoryState, after: HistoryState): DurableFileChange[] {
    const changes: DurableFileChange[] = [];
    const add = (path: string, value: unknown): void => {
      const absolute = join(this.graphRoot, path);
      changes.push(optionalChange(path, "history", existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined, JSON.stringify(value, null, 2)));
    };
    add(HISTORY_INDEX_FILE, { currentSegment: after.segmentId, sealedSegments: after.sealedSegments });
    if (after.previousSealed) add(`${HISTORY_SEGMENTS_DIR}/${after.previousSealed.segmentId}.json`, this.serializableSegment(after.previousSealed));
    add(`${HISTORY_SEGMENTS_DIR}/${after.segmentId}.json`, this.serializableSegment(after));
    const legacyPath = join(this.graphRoot, HISTORY_FILE);
    if (existsSync(legacyPath)) changes.push(optionalChange(HISTORY_FILE, "history", readFileSync(legacyPath, "utf8"), undefined));
    return changes;
  }

  private serializableSegment(state: HistoryState): Omit<HistoryState, "previousSealed" | "sealedSegments"> {
    const segment: Omit<HistoryState, "previousSealed" | "sealedSegments"> = {
      entries: state.entries,
      cursor: state.cursor,
      segmentId: state.segmentId,
      baseRevision: state.baseRevision,
      baseline: state.baseline,
    };
    if (state.sealed !== undefined) segment.sealed = state.sealed;
    return segment;
  }

  private externalState(snapshot: GraphSnapshot): { changed: boolean; baseRevision: number } {
    const state = readJson<{ revision?: number; snapshotDigest?: string }>(join(this.graphRoot, REVISION_FILE), {});
    const auditPath = join(this.graphRoot, AUDIT_FILE);
    let baselineRevision = Number.isInteger(state.revision) ? state.revision! : snapshot.revision;
    let baselineDigest = state.snapshotDigest;
    if (existsSync(auditPath)) {
      const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
      try {
        const last = JSON.parse(lines.at(-1) ?? "{}") as { toRevision?: number; checksumSummary?: { after?: string } };
        if (Number.isInteger(last.toRevision) && typeof last.checksumSummary?.after === "string") {
          baselineRevision = last.toRevision!;
          baselineDigest = last.checksumSummary.after;
        }
      } catch {
        // Audit corruption is handled by the recovery/verification boundary.
      }
    }
    if (typeof baselineDigest !== "string") return { changed: false, baseRevision: baselineRevision };
    const normalized = { ...snapshot, revision: baselineRevision };
    return {
      changed: state.revision !== baselineRevision || snapshotDigest(normalized) !== baselineDigest,
      baseRevision: baselineRevision,
    };
  }

  private nextSegmentId(history: HistoryState): string {
    const next = history.sealedSegments.length + 2;
    return `seg_${String(next).padStart(4, "0")}`;
  }

}

function optionalChange(path: string, role: DurableFileChange["role"], before: string | undefined, after: string | undefined): DurableFileChange {
  const change: { path: string; role: DurableFileChange["role"]; before?: string; after?: string } = { path, role };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  return change;
}

function snapshotDigest(snapshot: GraphSnapshot): string {
  const canonical = JSON.stringify({
    manifest: snapshot.manifest,
    objects: sortedRecords(snapshot.objects),
    relations: sortedRecords(snapshot.relations),
    revision: snapshot.revision,
  });
  return `digest:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}
