/** Browser-facing copy of the stable TopoRealm graph protocol. */

export interface GraphModuleRef {
  id: string;
  namespace: string;
  schema: number;
}

export interface GraphManifest {
  format: "toporealm.graph/v1";
  id: string;
  label?: string;
  modules?: GraphModuleRef[];
  sources: { objects: string; relations: string };
  meta?: Record<string, unknown>;
}

export interface GraphObject {
  id: string;
  kind: string;
  label: string;
  data?: Record<string, unknown>;
  capabilities?: Record<string, Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

export interface GraphRelation {
  id: string;
  kind: string;
  source: string;
  target: string;
  direction: "directed" | "undirected";
  label?: string;
  data?: Record<string, unknown>;
  capabilities?: Record<string, Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

export interface GraphSnapshot {
  manifest: GraphManifest;
  objects: GraphObject[];
  relations: GraphRelation[];
  revision: number;
}

export type CanvasSelection = { type: "object" | "relation"; id: string };

export type Mutation =
  | { op: "upsert_object"; object: GraphObject }
  | { op: "delete_object"; id: string }
  | { op: "upsert_relation"; relation: GraphRelation }
  | { op: "delete_relation"; id: string }
  | { op: "patch_manifest"; patch: Partial<Pick<GraphManifest, "label" | "modules" | "meta">> };

export interface MutationPlan {
  mutations: Mutation[];
  expectedRevision?: number;
  label?: string;
}

export interface GraphPatch {
  fromRevision: number;
  toRevision: number;
  objects: {
    added: GraphObject[];
    updated: GraphObject[];
    deleted: string[];
  };
  relations: {
    added: GraphRelation[];
    updated: GraphRelation[];
    deleted: string[];
  };
  manifestChanged: boolean;
  manifest?: GraphManifest;
}

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
}

export interface GraphSummary {
  id: string;
  label?: string;
  revision: number;
  objectCount: number;
  relationCount: number;
}

export interface GraphListResult {
  currentId: string;
  graphs: GraphSummary[];
}

export interface ModuleStatus {
  id: string;
  namespace?: string;
  status: "available" | "unavailable";
  source?: string;
  version?: string;
  reason?: string;
}

export interface ModuleStatusResult {
  registryRevision: number;
  modules: ModuleStatus[];
  ui?: Record<string, unknown>;
  operations?: ModuleOperation[];
}

export interface ModuleOperation {
  id: string;
  fullId: string;
  moduleId: string;
  declaration?: unknown;
}

export type ActionResult =
  | { kind: "mutation"; operation: string; mutation: MutationResult }
  | { kind: "result"; operation: string; result: unknown; effects: "none" | "artifact" | "external" };

export interface MutationResult {
  snapshot: GraphSnapshot;
  patch: GraphPatch;
  history: HistoryStatus;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface GraphValidationResult {
  ok: boolean;
  complete: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export class GraphApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "GraphApiError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

/** Local revisioned projection. A patch gap never mutates the current snapshot. */
export class WebGraphState {
  private current: GraphSnapshot;

  constructor(snapshot: GraphSnapshot) {
    this.current = clone(snapshot);
  }

  get snapshot(): GraphSnapshot {
    return clone(this.current);
  }

  applyPatch(patch: GraphPatch): GraphSnapshot {
    if (patch.fromRevision !== this.current.revision) {
      throw new GraphApiError(
        "PATCH_GAP",
        `Web 视图需要 revision ${this.current.revision}，收到 ${patch.fromRevision}。`,
        409,
        { expectedRevision: this.current.revision, patchFrom: patch.fromRevision },
      );
    }
    if (patch.toRevision < patch.fromRevision) {
      throw new GraphApiError("INVALID_PATCH", "收到的 patch revision 逆序。", 400, {
        fromRevision: patch.fromRevision,
        toRevision: patch.toRevision,
      });
    }
    const objects = new Map(this.current.objects.map((object) => [object.id, clone(object)]));
    const relations = new Map(this.current.relations.map((relation) => [relation.id, clone(relation)]));
    for (const object of patch.objects.added) objects.set(object.id, clone(object));
    for (const object of patch.objects.updated) objects.set(object.id, clone(object));
    for (const id of patch.objects.deleted) objects.delete(id);
    for (const relation of patch.relations.added) relations.set(relation.id, clone(relation));
    for (const relation of patch.relations.updated) relations.set(relation.id, clone(relation));
    for (const id of patch.relations.deleted) relations.delete(id);
    this.current = {
      manifest: patch.manifestChanged && patch.manifest ? clone(patch.manifest) : this.current.manifest,
      objects: [...objects.values()].sort(byId),
      relations: [...relations.values()].sort(byId),
      revision: patch.toRevision,
    };
    return this.snapshot;
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

/** Thin fetch adapter; it does not maintain state or silently recover conflicts. */
export class ToporealmApi {
  constructor(private readonly baseUrl = "") {}

  async readGraph(): Promise<GraphSnapshot> {
    return this.request<GraphSnapshot>("/api/graph");
  }

  async apply(plan: MutationPlan): Promise<MutationResult> {
    return this.request<MutationResult>("/api/mutations", {
      method: "POST",
      body: JSON.stringify(plan),
    });
  }

  async undo(expectedRevision?: number): Promise<MutationResult> {
    return this.historyMutation("/api/undo", expectedRevision);
  }

  async redo(expectedRevision?: number): Promise<MutationResult> {
    return this.historyMutation("/api/redo", expectedRevision);
  }

  async history(): Promise<HistoryStatus> {
    return this.request<HistoryStatus>("/api/history");
  }

  async listGraphs(): Promise<GraphListResult> {
    return this.request<GraphListResult>("/api/graphs");
  }

  async switchGraph(id: string): Promise<{ snapshot: GraphSnapshot; history: HistoryStatus; graph: GraphSummary }> {
    return this.request<{ snapshot: GraphSnapshot; history: HistoryStatus; graph: GraphSummary }>("/api/graph/switch", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  async modules(): Promise<ModuleStatusResult> {
    return this.request<ModuleStatusResult>("/api/modules");
  }

  async executeAction(operation: string, target: string | undefined, input: Record<string, unknown>, registryRevision?: number): Promise<ActionResult> {
    const body: { operation: string; input: Record<string, unknown>; target?: string; registryRevision?: number } = { operation, input };
    if (target !== undefined) body.target = target;
    if (registryRevision !== undefined) body.registryRevision = registryRevision;
    return this.request<ActionResult>("/api/actions", { method: "POST", body: JSON.stringify(body) });
  }

  async validate(): Promise<GraphValidationResult> {
    return this.request<GraphValidationResult>("/api/validate");
  }

  async validateComplete(): Promise<GraphValidationResult> {
    return this.request<GraphValidationResult>("/api/validate?mode=complete");
  }

  private async historyMutation(path: string, expectedRevision?: number): Promise<MutationResult> {
    const body: { expectedRevision?: number } = {};
    if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;
    return this.request<MutationResult>(path, { method: "POST", body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new GraphApiError("INVALID_RESPONSE", "Server 返回了无法读取的响应。", response.status);
    }
    if (!response.ok) {
      const error = (value as ApiErrorBody).error;
      throw new GraphApiError(
        error?.code ?? "HTTP_ERROR",
        error?.message ?? `请求失败（HTTP ${response.status}）。`,
        response.status,
        error?.details,
      );
    }
    return value as T;
  }
}
