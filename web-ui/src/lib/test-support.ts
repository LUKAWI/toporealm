// 测试支撑：1.0 Session 契约的内存假件（blueprint §8 精神——只打公共缝）。
// 供 store.test / App.test 注入 store.provider，验证 store/组件与 Session 契约的接合。
import { TopoError, type Catalog, type Change, type CommitResult, type Entity, type GraphPatch, type GraphSnapshot, type ReadResult, type RelationEntity, type Session, type TopoEvent } from "./protocol";

export interface FakeSessionState {
  revision: number;
  objects: Entity[];
  relations: RelationEntity[];
  canUndo: boolean;
  canRedo: boolean;
}

export function obj(id: string, kind: string, title?: string, payload: Record<string, unknown> = {}): Entity {
  return { id, kind, payload: title !== undefined ? { title, ...payload } : payload };
}

export function rel(id: string, kind: string, source: string, target: string, direction: "directed" | "undirected" = "directed", payload: Record<string, unknown> = {}): RelationEntity {
  return { id, kind, source, target, direction, payload };
}

export function snapshotOf(state: FakeSessionState): GraphSnapshot {
  return {
    graphId: "demo",
    revision: state.revision,
    objects: [...state.objects],
    relations: [...state.relations],
  };
}

function diffPatch(before: FakeSessionState, after: FakeSessionState): GraphPatch {
  const beforeObjects = new Map(before.objects.map((o) => [o.id, o]));
  const afterObjects = new Map(after.objects.map((o) => [o.id, o]));
  const beforeRelations = new Map(before.relations.map((r) => [r.id, r]));
  const afterRelations = new Map(after.relations.map((r) => [r.id, r]));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return {
    fromRevision: before.revision,
    toRevision: after.revision,
    objects: {
      added: after.objects.filter((o) => !beforeObjects.has(o.id)),
      updated: after.objects.filter((o) => beforeObjects.has(o.id) && !same(beforeObjects.get(o.id), o)),
      deleted: before.objects.filter((o) => !afterObjects.has(o.id)).map((o) => o.id),
    },
    relations: {
      added: after.relations.filter((r) => !beforeRelations.has(r.id)),
      updated: after.relations.filter((r) => beforeRelations.has(r.id) && !same(beforeRelations.get(r.id), r)),
      deleted: before.relations.filter((r) => !afterRelations.has(r.id)).map((r) => r.id),
    },
  };
}

const cloneState = (state: FakeSessionState): FakeSessionState => JSON.parse(JSON.stringify(state)) as FakeSessionState;

let generated = 0;

function applyChanges(state: FakeSessionState, changes: readonly Change[]): CommitResult {
  const before = cloneState(state);
  const created: string[] = [];
  for (const change of changes) {
    if (change.op === "put") {
      const id = change.id ?? `gen-${++generated}`;
      if (change.id === undefined) created.push(id);
      const existing = state.objects.find((o) => o.id === id);
      if (existing) {
        // upsert 保型：kind 可省；payload 整体替换（blueprint §1 D18）
        state.objects = state.objects.map((o) => (o.id === id ? { id, kind: o.kind, payload: change.payload ?? {} } : o));
      } else {
        state.objects = [...state.objects, { id, kind: change.kind as string, payload: change.payload ?? {} }];
      }
    } else if (change.op === "rel") {
      const id = change.id ?? `gen-rel-${++generated}`;
      if (change.id === undefined) created.push(id);
      const relation: RelationEntity = { id, kind: change.kind, source: change.source, target: change.target, payload: change.payload ?? {} };
      if (change.direction !== undefined) relation.direction = change.direction;
      state.relations = [...state.relations, relation];
    } else if (change.op === "merge") {
      state.objects = state.objects.map((o) =>
        o.id === change.id
          ? { ...o, payload: { ...o.payload, ...Object.fromEntries(Object.entries(change.payload).filter(([, v]) => v !== null)) } }
          : o,
      );
    } else if (change.op === "del") {
      state.objects = state.objects.filter((o) => o.id !== change.id);
      state.relations = state.relations.filter((r) => r.id !== change.id);
    }
  }
  state.revision += 1;
  state.canUndo = true;
  state.canRedo = false;
  return {
    revision: state.revision,
    created,
    patch: diffPatch(before, state),
    canUndo: state.canUndo,
    canRedo: state.canRedo,
  };
}

export interface FakeSessionOptions {
  /** commit 拦截：默认按 changes 改本地 state；抛错 = daemon 拒绝 */
  onCommit?: (changes: readonly Change[]) => Promise<void> | void;
  onUndo?: () => Promise<void> | void;
  failUndoWith?: TopoError;
}

export function makeFakeSession(state: FakeSessionState, options: FakeSessionOptions = {}): Session & {
  calls: Record<string, number>;
  emit(e: TopoEvent): void;
  state: FakeSessionState;
  catalogData: Catalog;
  commitResult: CommitResult | null;
} {
  const calls: Record<string, number> = {};
  const listeners = new Set<(e: TopoEvent) => void>();
  const catalogData: Catalog = {
    modules: [{ id: "research", namespace: "research", version: "1.0.0" }],
    kinds: [{ kind: "research.question", owner: "research", color: "#6d28d9" }],
    commands: [
      { id: "research.expand", module: "research", title: "展开问题", target: "research.question", input: { type: "object" } },
    ],
  };
  let lastCommitResult: CommitResult | null = null;

  const session = {
    graphId: "demo",
    instanceId: "inst-fake",
    calls,
    state,
    catalogData,
    get commitResult() {
      return lastCommitResult;
    },
    emit(e: TopoEvent): void {
      for (const l of [...listeners]) l(e);
    },
    async status() {
      calls.status = (calls.status ?? 0) + 1;
      return {
        graphId: "demo",
        revision: state.revision,
        counts: {},
        modules: [],
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    },
    async read(): Promise<ReadResult> {
      calls.read = (calls.read ?? 0) + 1;
      return { revision: state.revision, entities: [...state.objects, ...state.relations] };
    },
    async log() {
      calls.log = (calls.log ?? 0) + 1;
      return [];
    },
    async commit(input: { changes: readonly Change[] }) {
      calls.commit = (calls.commit ?? 0) + 1;
      if (options.onCommit) await options.onCommit(input.changes);
      lastCommitResult = applyChanges(state, input.changes);
      return lastCommitResult;
    },
    async undo() {
      calls.undo = (calls.undo ?? 0) + 1;
      if (options.failUndoWith) throw options.failUndoWith;
      if (options.onUndo) await options.onUndo();
      const before = cloneState(state);
      state.revision += 1;
      return {
        revision: state.revision,
        created: [],
        patch: diffPatch(before, state),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    },
    async redo() {
      calls.redo = (calls.redo ?? 0) + 1;
      const before = cloneState(state);
      state.revision += 1;
      return {
        revision: state.revision,
        created: [],
        patch: diffPatch(before, state),
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    },
    async catalog() {
      calls.catalog = (calls.catalog ?? 0) + 1;
      return catalogData;
    },
    async run(commandId: string, opts?: { target?: string; input?: unknown }) {
      calls.run = (calls.run ?? 0) + 1;
      void commandId;
      void opts;
      return { message: "ok", commits: [] };
    },
    async events(listener: (e: TopoEvent) => void) {
      calls.events = (calls.events ?? 0) + 1;
      listeners.add(listener);
      listener({ type: "hello", graphId: "demo", revision: state.revision });
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      calls.close = (calls.close ?? 0) + 1;
    },
  };
  return session as unknown as Session & typeof session;
}
