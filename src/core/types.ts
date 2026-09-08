/** The alpha graph format intentionally contains no domain-specific enums. */
export const GRAPH_FORMAT = "toporealm.graph/v1alpha1" as const;
export type GraphFormat = typeof GRAPH_FORMAT;

export type EntityId = string;
export type ModuleId = string;
export type ModuleNamespace = string;

export interface GraphModuleRef {
  id: ModuleId;
  namespace: ModuleNamespace;
  schema: number;
}

export interface GraphSources {
  objects: string;
  relations: string;
}

export interface GraphManifest {
  format: GraphFormat;
  id: string;
  label?: string;
  modules?: GraphModuleRef[];
  sources: GraphSources;
  meta?: Record<string, unknown>;
}

export interface ObjectRecord {
  id: EntityId;
  kind: string;
  label: string;
  data?: Record<string, unknown>;
  capabilities?: Record<string, Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

export type RelationDirection = "directed" | "undirected";

export interface RelationRecord {
  id: EntityId;
  kind: string;
  source: EntityId;
  target: EntityId;
  direction: RelationDirection;
  label?: string;
  data?: Record<string, unknown>;
  capabilities?: Record<string, Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

export interface GraphSnapshot {
  manifest: GraphManifest;
  objects: readonly ObjectRecord[];
  relations: readonly RelationRecord[];
  revision: number;
}

export type ObjectMutation =
  | { op: "upsert_object"; object: ObjectRecord }
  | { op: "delete_object"; id: EntityId };

export type RelationMutation =
  | { op: "upsert_relation"; relation: RelationRecord }
  | { op: "delete_relation"; id: EntityId };

export type ManifestMutation = {
  op: "patch_manifest";
  patch: Partial<Pick<GraphManifest, "label" | "modules" | "meta">>;
};

/** A single user/agent command. It is the atomic unit for undo and redo. */
export type Mutation = ObjectMutation | RelationMutation | ManifestMutation;

export interface MutationPlan {
  mutations: readonly Mutation[];
  expectedRevision?: number;
  label?: string;
}

export interface GraphPatch {
  fromRevision: number;
  toRevision: number;
  objects: {
    added: readonly ObjectRecord[];
    updated: readonly ObjectRecord[];
    deleted: readonly EntityId[];
  };
  relations: {
    added: readonly RelationRecord[];
    updated: readonly RelationRecord[];
    deleted: readonly EntityId[];
  };
  manifestChanged: boolean;
  manifest?: GraphManifest;
}

export interface MutationResult {
  snapshot: GraphSnapshot;
  patch: GraphPatch;
  history: {
    canUndo: boolean;
    canRedo: boolean;
  };
}

export interface CoreErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CoreSurface {
  readonly name: "core";
  readonly graphFormat: GraphFormat;
}
