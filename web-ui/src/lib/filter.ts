import type { GraphObject, GraphRelation, GraphSnapshot } from "./protocol";

export interface GraphFilter {
  query?: string;
  kind?: string;
}

export interface FilteredGraph {
  objects: GraphObject[];
  relations: GraphRelation[];
}

function matches(value: string, query: string): boolean {
  return !query || value.toLocaleLowerCase().includes(query);
}

/** View-only filter; the input snapshot is never mutated. */
export function filterGraphSnapshot(snapshot: GraphSnapshot | null, filter: GraphFilter = {}): FilteredGraph {
  if (!snapshot) return { objects: [], relations: [] };
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const kind = filter.kind?.trim() ?? "";
  const objects = snapshot.objects.filter((object) => matches(`${object.id} ${object.kind} ${object.label} ${JSON.stringify(object.data ?? {})}`, query) && (!kind || object.kind === kind));
  const visible = new Set(objects.map((object) => object.id));
  const relations = snapshot.relations.filter((relation) => matches(`${relation.id} ${relation.kind} ${relation.label ?? ""} ${relation.source} ${relation.target}`, query) && (!kind || visible.has(relation.source) || visible.has(relation.target)) && visible.has(relation.source) && visible.has(relation.target));
  return { objects, relations };
}
