import { titleOf, type Entity, type GraphSnapshot, type RelationEntity } from "./protocol";

export interface GraphFilter {
  query?: string;
  kind?: string;
}

export interface FilteredGraph {
  objects: Entity[];
  relations: RelationEntity[];
}

function matches(value: string, query: string): boolean {
  return !query || value.toLocaleLowerCase().includes(query);
}

/** View-only filter; the input snapshot is never mutated. */
export function filterGraphSnapshot(snapshot: GraphSnapshot | null, filter: GraphFilter = {}): FilteredGraph {
  if (!snapshot) return { objects: [], relations: [] };
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const kind = filter.kind?.trim() ?? "";
  // 1.0 视图投影：显示名 = payload.title（titleOf），检索面 = id/kind/title/payload
  const objects = snapshot.objects.filter((object) => matches(`${object.id} ${object.kind} ${titleOf(object)} ${JSON.stringify(object.payload ?? {})}`, query) && (!kind || object.kind === kind));
  const visible = new Set(objects.map((object) => object.id));
  const relations = snapshot.relations.filter((relation) => matches(`${relation.id} ${relation.kind} ${titleOf(relation)} ${relation.source} ${relation.target}`, query) && (!kind || visible.has(relation.source) || visible.has(relation.target)) && visible.has(relation.source) && visible.has(relation.target));
  return { objects, relations };
}
