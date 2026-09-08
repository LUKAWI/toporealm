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

export interface CoreSurface {
  readonly name: "core";
  readonly graphFormat: GraphFormat;
}
