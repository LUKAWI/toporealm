import { coreSurface } from "../core/index.js";
import { CoreError } from "../core/index.js";
import type { GraphPatch, GraphSnapshot, ObjectRecord, RelationRecord } from "../core/index.js";

export const webSurface = {
  name: "web",
  coreFormat: coreSurface.graphFormat,
} as const;

/** Client-side projection that consumes the same revisioned patches returned by Core. */
export class WebGraphModel {
  private current: GraphSnapshot;

  constructor(snapshot: GraphSnapshot) {
    this.current = structuredClone(snapshot);
  }

  get snapshot(): GraphSnapshot {
    return structuredClone(this.current);
  }

  applyPatch(patch: GraphPatch): GraphSnapshot {
    if (patch.fromRevision !== this.current.revision) {
      throw new CoreError({
        code: "PATCH_GAP",
        message: `Web 视图需要 revision ${this.current.revision}，收到 ${patch.fromRevision}。`,
        details: { expectedRevision: this.current.revision, patchFrom: patch.fromRevision },
      });
    }
    const objects = new Map(this.current.objects.map((object) => [object.id, structuredClone(object)]));
    const relations = new Map(this.current.relations.map((relation) => [relation.id, structuredClone(relation)]));
    for (const object of patch.objects.added) objects.set(object.id, structuredClone(object));
    for (const object of patch.objects.updated) objects.set(object.id, structuredClone(object));
    for (const id of patch.objects.deleted) objects.delete(id);
    for (const relation of patch.relations.added) relations.set(relation.id, structuredClone(relation));
    for (const relation of patch.relations.updated) relations.set(relation.id, structuredClone(relation));
    for (const id of patch.relations.deleted) relations.delete(id);
    this.current = {
      manifest: patch.manifestChanged && patch.manifest ? structuredClone(patch.manifest) : this.current.manifest,
      objects: [...objects.values()].sort(byId),
      relations: [...relations.values()].sort(byId),
      revision: patch.toRevision,
    };
    return this.snapshot;
  }
}

export interface UiExtensionResult<T> {
  enabled: boolean;
  value: T;
  error?: string;
}

/** One extension failing must leave the generic surface usable. */
export function withUiErrorBoundary<T>(extension: () => T, fallback: () => T): UiExtensionResult<T> {
  try {
    return { enabled: true, value: extension() };
  } catch (error) {
    return { enabled: false, value: fallback(), error: error instanceof Error ? error.message : String(error) };
  }
}

function byId(left: ObjectRecord | RelationRecord, right: ObjectRecord | RelationRecord): number {
  return left.id.localeCompare(right.id);
}

export function renderWebShell(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TopoRealm</title><style>body{font:15px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}button{margin:.25rem;padding:.45rem .7rem}pre{background:#f5f5f5;padding:1rem;overflow:auto}</style></head>
<body><h1>TopoRealm</h1><p>最薄基座 Web 视图：读取图快照，并把编辑结果作为 revision patch 应用。</p>
<p><button id="refresh">刷新</button><button id="undo">撤销</button><button id="redo">重做</button></p><pre id="state">加载中…</pre>
<script>
const state=document.querySelector('#state');
async function get(){const r=await fetch('/graph'); const v=await r.json(); state.textContent=JSON.stringify(v,null,2);}
async function action(path){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); const v=await r.json(); state.textContent=JSON.stringify(v,null,2);}
document.querySelector('#refresh').onclick=get; document.querySelector('#undo').onclick=()=>action('/undo'); document.querySelector('#redo').onclick=()=>action('/redo'); get();
</script></body></html>`;
}
