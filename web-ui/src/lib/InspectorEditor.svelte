<script lang="ts">
  import { GraphApiError, type ActionResult, type CanvasSelection, type GraphObject, type GraphRelation, type GraphSnapshot, type ModuleStatusResult, type MutationPlan } from "./protocol";
  import { projectModuleKind, type ModuleOperationProjection } from "./moduleProjection";

  export let snapshot: GraphSnapshot | null = null;
  export let selection: CanvasSelection | null = null;
  export let readOnly = false;
  export let moduleRegistry: ModuleStatusResult | null = null;
  export let onCommit: (plan: MutationPlan) => Promise<void> = async () => undefined;
  export let onAction: (operation: string, target: string | undefined, input: Record<string, unknown>, registryRevision?: number) => Promise<ActionResult | void> = async () => undefined;
  export let onSelect: (next: CanvasSelection | null) => void = () => undefined;

  type EditorMode = "view" | "object" | "relation";
  let mode: EditorMode = "view";
  let objectId = "";
  let objectKind = "plain";
  let objectLabel = "";
  let objectData = "{}";
  let objectCapabilities = "{}";
  let objectMeta = "{}";
  let relationId = "";
  let relationKind = "related_to";
  let relationSource = "";
  let relationTarget = "";
  let relationDirection: GraphRelation["direction"] = "directed";
  let relationLabel = "";
  let relationData = "{}";
  let relationCapabilities = "{}";
  let relationMeta = "{}";
  let formError = "";
  let formMessage = "";
  let submitting = false;
  let runningOperation = "";
  let seenSelectionKey = "";

  $: selectedObject = selection?.type === "object" ? snapshot?.objects.find((object) => object.id === selection?.id) : undefined;
  $: selectedRelation = selection?.type === "relation" ? snapshot?.relations.find((relation) => relation.id === selection?.id) : undefined;
  $: selectedKind = selectedObject?.kind ?? selectedRelation?.kind;
  $: moduleProjection = selectedKind ? projectModuleKind(selectedKind, moduleRegistry) : null;
  $: selectionKey = selection ? `${selection.type}:${selection.id}` : "";
  $: if (selectionKey !== seenSelectionKey) {
    seenSelectionKey = selectionKey;
    loadSelectedRecord();
  }
  $: if (readOnly && mode !== "view") mode = "view";

  function json(value: unknown): string {
    return value === undefined ? "（无）" : JSON.stringify(value, null, 2);
  }

  function parseObjectJson(value: string, label: string): Record<string, unknown> | undefined {
    if (!value.trim()) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${label} 必须是合法 JSON。`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 对象。`);
    return parsed as Record<string, unknown>;
  }

  function parseCapabilitiesJson(value: string): Record<string, Record<string, unknown>> | undefined {
    const parsed = parseObjectJson(value, "capabilities");
    if (parsed === undefined) return undefined;
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`capabilities.${key} 必须是 JSON 对象。`);
    }
    return parsed as Record<string, Record<string, unknown>>;
  }

  function loadSelectedRecord(): void {
    mode = "view";
    formError = "";
    formMessage = "";
    if (selectedObject) {
      objectId = selectedObject.id;
      objectKind = selectedObject.kind;
      objectLabel = selectedObject.label;
      objectData = json(selectedObject.data === undefined ? {} : selectedObject.data);
      objectCapabilities = json(selectedObject.capabilities === undefined ? {} : selectedObject.capabilities);
      objectMeta = json(selectedObject.meta === undefined ? {} : selectedObject.meta);
    }
    if (selectedRelation) {
      relationId = selectedRelation.id;
      relationKind = selectedRelation.kind;
      relationSource = selectedRelation.source;
      relationTarget = selectedRelation.target;
      relationDirection = selectedRelation.direction;
      relationLabel = selectedRelation.label ?? "";
      relationData = json(selectedRelation.data === undefined ? {} : selectedRelation.data);
      relationCapabilities = json(selectedRelation.capabilities === undefined ? {} : selectedRelation.capabilities);
      relationMeta = json(selectedRelation.meta === undefined ? {} : selectedRelation.meta);
    }
  }

  function newObject(): void {
    if (readOnly) return;
    mode = "object";
    formError = "";
    formMessage = "";
    objectId = "";
    objectKind = "plain";
    objectLabel = "";
    objectData = "{}";
    objectCapabilities = "{}";
    objectMeta = "{}";
  }

  function newRelation(): void {
    if (readOnly) return;
    mode = "relation";
    formError = "";
    formMessage = "";
    relationId = "";
    relationKind = "related_to";
    relationSource = selection?.type === "object" ? selection.id : "";
    relationTarget = "";
    relationDirection = "directed";
    relationLabel = "";
    relationData = "{}";
    relationCapabilities = "{}";
    relationMeta = "{}";
  }

  function editSelected(): void {
    if (readOnly) return;
    if (selectedObject || selectedRelation) mode = selection?.type ?? "view";
    formError = "";
    formMessage = "";
  }

  function objectFromForm(): GraphObject {
    if (!objectId.trim() || !objectKind.trim() || !objectLabel.trim()) throw new Error("对象 ID、kind 和 label 不能为空。");
    const object: GraphObject = { id: objectId.trim(), kind: objectKind.trim(), label: objectLabel };
    const data = parseObjectJson(objectData, "data");
    const capabilities = parseCapabilitiesJson(objectCapabilities);
    const meta = parseObjectJson(objectMeta, "meta");
    if (data !== undefined) object.data = data;
    if (capabilities !== undefined) object.capabilities = capabilities;
    if (meta !== undefined) object.meta = meta;
    return object;
  }

  function relationFromForm(): GraphRelation {
    if (!relationId.trim() || !relationKind.trim() || !relationSource.trim() || !relationTarget.trim()) throw new Error("关系 ID、kind、source 和 target 不能为空。");
    const relation: GraphRelation = {
      id: relationId.trim(),
      kind: relationKind.trim(),
      source: relationSource.trim(),
      target: relationTarget.trim(),
      direction: relationDirection,
    };
    if (relationLabel.trim()) relation.label = relationLabel;
    const data = parseObjectJson(relationData, "data");
    const capabilities = parseCapabilitiesJson(relationCapabilities);
    const meta = parseObjectJson(relationMeta, "meta");
    if (data !== undefined) relation.data = data;
    if (capabilities !== undefined) relation.capabilities = capabilities;
    if (meta !== undefined) relation.meta = meta;
    return relation;
  }

  async function save(): Promise<void> {
    if (readOnly) return;
    formError = "";
    formMessage = "";
    submitting = true;
    try {
      const plan: MutationPlan = mode === "object"
        ? { label: selectedObject ? `修改对象 ${objectId}` : `新增对象 ${objectId}`, mutations: [{ op: "upsert_object", object: objectFromForm() }] }
        : { label: selectedRelation ? `修改关系 ${relationId}` : `新增关系 ${relationId}`, mutations: [{ op: "upsert_relation", relation: relationFromForm() }] };
      await onCommit(plan);
      formMessage = "已保存，revision 已更新。";
      mode = "view";
      if (!selection && plan.mutations[0]?.op === "upsert_object") onSelect({ type: "object", id: objectId });
      if (!selection && plan.mutations[0]?.op === "upsert_relation") onSelect({ type: "relation", id: relationId });
    } catch (cause) {
      formError = cause instanceof GraphApiError && cause.code === "REVISION_CONFLICT"
        ? `${cause.message} 表单内容已保留，请刷新后重试。`
        : cause instanceof Error ? cause.message : "保存失败，表单内容已保留。";
    } finally {
      submitting = false;
    }
  }

  async function removeSelected(): Promise<void> {
    if (readOnly) return;
    if (!selection) return;
    formError = "";
    formMessage = "";
    submitting = true;
    try {
      const plan: MutationPlan = selection.type === "object"
        ? { label: `删除对象 ${selection.id}`, mutations: [{ op: "delete_object", id: selection.id }] }
        : { label: `删除关系 ${selection.id}`, mutations: [{ op: "delete_relation", id: selection.id }] };
      await onCommit(plan);
      formMessage = selection.type === "object" ? "对象已删除，关联关系按 Core 语义一并移除。" : "关系已删除。";
      onSelect(null);
      mode = "view";
    } catch (cause) {
      formError = cause instanceof GraphApiError && cause.code === "REVISION_CONFLICT"
        ? `${cause.message} 请刷新后重试。`
        : cause instanceof Error ? cause.message : "删除失败。";
    } finally {
      submitting = false;
    }
  }

  async function runModuleAction(operation: ModuleOperationProjection): Promise<void> {
    if (readOnly || !selection) return;
    formError = "";
    formMessage = "";
    runningOperation = operation.operation;
    try {
      const input = operation.inputTemplate && typeof operation.inputTemplate === "object" && !Array.isArray(operation.inputTemplate)
        ? operation.inputTemplate as Record<string, unknown>
        : {};
      await onAction(operation.operation, selection.id, input, moduleRegistry?.registryRevision);
      formMessage = `动作 ${operation.operation} 已执行。`;
    } catch (cause) {
      formError = cause instanceof Error ? cause.message : "模块动作失败，当前画布和表单未改变。";
    } finally {
      runningOperation = "";
    }
  }

  async function copyRaw(): Promise<void> {
    const value = selectedObject ?? selectedRelation;
    if (!value) return;
    const text = JSON.stringify(value, null, 2);
    try {
      await navigator.clipboard?.writeText(text);
      formMessage = "原始 JSON 已复制。";
    } catch {
      formMessage = "当前浏览器不允许自动复制，请手动选择下方 JSON。";
    }
  }
</script>

<div class="inspector-editor">
  <div class="editor-header">
    <div><div class="eyebrow">INSPECTOR</div><div class="inspector-title">{mode === "view" ? "Object details" : mode === "object" ? "Edit object" : "Edit relation"}</div></div>
    <span class="inspector-badge">GENERIC</span>
  </div>

  <div class="editor-actions">
    <button type="button" class="action-button primary" disabled={readOnly} on:click={newObject}>＋ 对象</button>
    <button type="button" class="action-button" disabled={readOnly} on:click={newRelation}>＋ 关系</button>
  </div>
  {#if readOnly}<div class="readonly-note">只读模式：可查看与复制原始数据，写操作已禁用。</div>{/if}

  {#if formError}<div class="editor-message error" role="alert">{formError}</div>{/if}
  {#if formMessage}<div class="editor-message success" role="status">{formMessage}</div>{/if}

  {#if moduleProjection && (selectedObject || selectedRelation)}
    <section class:degraded={!moduleProjection.available} class="module-slot" style={`--module-color: ${moduleProjection.presentation?.color ?? "#63d7ff"}`} aria-label="模块投影">
      <div class="module-slot-heading"><span class="module-icon" style={`--module-color: ${moduleProjection.presentation?.color ?? "#63d7ff"}`}>{moduleProjection.presentation?.icon ?? "◇"}</span><div><strong>{moduleProjection.moduleId ?? "通用"}</strong><small>{moduleProjection.available ? "声明式投影" : "已降级到通用界面"}</small></div></div>
      {#if moduleProjection.available}
        {#if moduleProjection.fields.length}<div class="module-fields"><span>专用字段</span>{#each moduleProjection.fields as field}<code>{field}</code>{/each}</div>{/if}
        {#if moduleProjection.operations.length}<div class="module-operations"><span>可用动作</span>{#each moduleProjection.operations as operation}<button type="button" class="module-action" disabled={readOnly || submitting || runningOperation !== ""} on:click={() => runModuleAction(operation)}>{runningOperation === operation.operation ? "执行中…" : operation.operation.split(".").pop()}</button>{/each}</div>{/if}
      {:else}<p>{moduleProjection.reason ?? "模块不可用"}，保留原始 kind/data/capabilities/meta。</p>{/if}
    </section>
  {/if}

  {#if mode === "view" && selectedObject}
    <div class="record-view">
      <div class="record-type"><span class="record-dot"></span><span>{selectedObject.kind}</span></div>
      <h3>{selectedObject.label}</h3>
      <dl><dt>稳定 ID</dt><dd><code>{selectedObject.id}</code></dd><dt>kind</dt><dd><code>{selectedObject.kind}</code></dd></dl>
      <div class="raw-heading"><span>原始扩展</span><button type="button" class="text-button" on:click={copyRaw}>复制 JSON</button></div>
      <pre class="raw-json">{json(selectedObject)}</pre>
      <div class="record-actions"><button type="button" class="action-button primary" disabled={readOnly} on:click={editSelected}>编辑对象</button><button type="button" class="action-button danger" on:click={removeSelected} disabled={readOnly || submitting}>删除</button><button type="button" class="action-button" disabled={readOnly} on:click={newRelation}>以此为起点连接</button></div>
    </div>
  {:else if mode === "view" && selectedRelation}
    <div class="record-view">
      <div class="record-type"><span class="record-line"></span><span>{selectedRelation.kind} · {selectedRelation.direction}</span></div>
      <h3>{selectedRelation.label ?? selectedRelation.id}</h3>
      <dl><dt>稳定 ID</dt><dd><code>{selectedRelation.id}</code></dd><dt>端点</dt><dd><code>{selectedRelation.source} {selectedRelation.direction === "directed" ? "→" : "—"} {selectedRelation.target}</code></dd></dl>
      <div class="raw-heading"><span>原始扩展</span><button type="button" class="text-button" on:click={copyRaw}>复制 JSON</button></div>
      <pre class="raw-json">{json(selectedRelation)}</pre>
      <div class="record-actions"><button type="button" class="action-button primary" disabled={readOnly} on:click={editSelected}>编辑关系</button><button type="button" class="action-button danger" on:click={removeSelected} disabled={readOnly || submitting}>删除</button></div>
    </div>
  {:else if mode === "view"}
    <div class="inspector-empty"><div class="inspector-orbit">⌘</div><strong>选择一个对象</strong><span>节点、关系和模块扩展会在这里显示。</span></div>
  {:else if mode === "object"}
    <form class="editor-form" on:submit|preventDefault={save}>
      <label>稳定 ID<input bind:value={objectId} disabled={readOnly} placeholder="例如 question-1" autocomplete="off" /></label>
      <label>kind / 命名空间<input bind:value={objectKind} disabled={readOnly} placeholder="例如 research.question" autocomplete="off" /></label>
      <label>label<input bind:value={objectLabel} disabled={readOnly} placeholder="显示名称" /></label>
      <label>data <span class="field-hint">JSON 对象</span><textarea bind:value={objectData} disabled={readOnly} rows="4" spellcheck="false"></textarea></label>
      <label>capabilities <span class="field-hint">JSON 对象</span><textarea bind:value={objectCapabilities} disabled={readOnly} rows="3" spellcheck="false"></textarea></label>
      <label>meta <span class="field-hint">JSON 对象</span><textarea bind:value={objectMeta} disabled={readOnly} rows="3" spellcheck="false"></textarea></label>
      <div class="form-actions"><button type="submit" class="action-button primary" disabled={submitting}>{submitting ? "保存中…" : "保存对象"}</button><button type="button" class="action-button" on:click={() => { mode = "view"; formError = ""; }}>取消</button></div>
    </form>
  {:else}
    <form class="editor-form" on:submit|preventDefault={save}>
      <label>稳定 ID<input bind:value={relationId} disabled={readOnly} placeholder="例如 relates-1" autocomplete="off" /></label>
      <label>kind<input bind:value={relationKind} disabled={readOnly} placeholder="例如 supports" autocomplete="off" /></label>
      <label>source<input list="object-ids" bind:value={relationSource} disabled={readOnly} placeholder="对象 ID" autocomplete="off" /></label>
      <label>target<input list="object-ids" bind:value={relationTarget} disabled={readOnly} placeholder="对象 ID" autocomplete="off" /></label>
      <datalist id="object-ids">{#each snapshot?.objects ?? [] as object}<option value={object.id}>{object.label}</option>{/each}</datalist>
      <label>方向<select bind:value={relationDirection} disabled={readOnly}><option value="directed">directed →</option><option value="undirected">undirected —</option></select></label>
      <label>label<input bind:value={relationLabel} disabled={readOnly} placeholder="可选显示名称" /></label>
      <label>data <span class="field-hint">JSON 对象</span><textarea bind:value={relationData} disabled={readOnly} rows="3" spellcheck="false"></textarea></label>
      <label>capabilities <span class="field-hint">JSON 对象</span><textarea bind:value={relationCapabilities} disabled={readOnly} rows="3" spellcheck="false"></textarea></label>
      <label>meta <span class="field-hint">JSON 对象</span><textarea bind:value={relationMeta} disabled={readOnly} rows="3" spellcheck="false"></textarea></label>
      <div class="form-actions"><button type="submit" class="action-button primary" disabled={submitting}>{submitting ? "保存中…" : "保存关系"}</button><button type="button" class="action-button" on:click={() => { mode = "view"; formError = ""; }}>取消</button></div>
    </form>
  {/if}
</div>

<style>
  .inspector-editor { display: flex; min-height: 100%; flex-direction: column; gap: 13px; }
  .editor-header { display: flex; align-items: center; justify-content: space-between; }
  .eyebrow { color: #7088aa; font-size: 10px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; }
  .inspector-title { margin-top: 4px; color: #eaf2ff; font-size: 15px; font-weight: 650; }
  .inspector-badge { display: inline-flex; align-items: center; border: 1px solid rgba(155, 140, 255, .25); border-radius: 999px; padding: 6px 8px; color: #b8adff; font-size: 9px; font-weight: 700; letter-spacing: .08em; }
  .editor-actions, .record-actions, .form-actions { display: flex; flex-wrap: wrap; gap: 7px; }
  .action-button, .text-button { border: 1px solid rgba(148,178,218,.16); border-radius: 8px; background: rgba(17,34,58,.62); color: #a9bdd8; cursor: pointer; font-size: 10px; transition: color .2s ease, border-color .2s ease, transform .2s ease; }
  .action-button { padding: 7px 9px; }
  .text-button { padding: 4px 6px; background: transparent; color: #77bfe2; }
  .action-button:hover, .action-button:focus-visible, .text-button:hover, .text-button:focus-visible { border-color: rgba(99,215,255,.5); color: #e8f7ff; transform: translateY(-1px); outline: none; }
  .action-button.primary { border-color: rgba(99,215,255,.35); color: #8ddfff; }
  .action-button.danger { border-color: rgba(255,127,143,.25); color: #ff9eac; }
  .action-button:disabled { cursor: wait; opacity: .55; transform: none; }
  .editor-message { border: 1px solid rgba(148,178,218,.14); border-radius: 8px; padding: 8px 9px; font-size: 10px; line-height: 1.45; }
  .editor-message.error { border-color: rgba(255,127,143,.3); background: rgba(110,34,53,.16); color: #ffc5cc; }
  .editor-message.success { border-color: rgba(82,230,178,.23); background: rgba(30,111,83,.12); color: #8ce8c1; }
  .readonly-note { border: 1px solid rgba(155,140,255,.2); border-radius: 8px; padding: 8px 9px; background: rgba(61,43,119,.12); color: #b8adff; font-size: 10px; line-height: 1.45; }
  .module-slot { display: grid; gap: 8px; border: 1px solid color-mix(in srgb, var(--module-color, #63d7ff) 30%, rgba(148,178,218,.12)); border-radius: 9px; padding: 9px; background: rgba(11,25,44,.48); }
  .module-slot.degraded { border-color: rgba(255,199,120,.28); background: rgba(110,68,32,.1); }
  .module-slot-heading { display: flex; align-items: center; gap: 8px; }
  .module-slot-heading strong { display: block; color: #cfe0f2; font-size: 11px; }
  .module-slot-heading small { display: block; margin-top: 2px; color: #7089a8; font-size: 9px; }
  .module-icon { display: grid; width: 25px; height: 25px; place-items: center; border: 1px solid color-mix(in srgb, var(--module-color) 50%, transparent); border-radius: 8px; color: var(--module-color); font-weight: 700; }
  .module-fields, .module-operations { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: #7189a8; font-size: 9px; }
  .module-fields code { border-radius: 4px; padding: 3px 4px; background: rgba(99,215,255,.08); color: #9bdfff; }
  .module-action { border: 1px solid rgba(99,215,255,.22); border-radius: 6px; padding: 4px 6px; background: rgba(20,55,82,.42); color: #9bdfff; cursor: pointer; font-size: 9px; }
  .module-action:hover, .module-action:focus-visible { border-color: rgba(99,215,255,.55); outline: none; }
  .module-action:disabled { cursor: wait; opacity: .55; }
  .module-slot p { margin: 0; color: #e7c67f; font-size: 9px; line-height: 1.45; }
  .record-view { display: grid; min-height: 0; gap: 11px; }
  .record-type { display: inline-flex; align-items: center; gap: 7px; color: #94b1d0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
  .record-dot, .record-line { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #63d7ff; box-shadow: 0 0 9px rgba(99,215,255,.7); }
  .record-line { width: 16px; height: 2px; border-radius: 0; background: #9b8cff; box-shadow: 0 0 8px rgba(155,140,255,.7); }
  h3 { margin: 0; overflow: hidden; color: #e5effd; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
  dl { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 7px 9px; margin: 0; }
  dt { color: #647f9f; font-size: 10px; text-transform: uppercase; }
  dd { min-width: 0; margin: 0; overflow: hidden; color: #adc3dc; font-size: 11px; text-overflow: ellipsis; }
  code { color: #9bdfff; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
  .raw-heading { display: flex; align-items: center; justify-content: space-between; color: #7f9abb; font-size: 10px; }
  .raw-json { max-height: 178px; margin: 0; overflow: auto; border: 1px solid rgba(148,178,218,.1); border-radius: 9px; padding: 9px; background: rgba(4,12,24,.48); color: #91abc8; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 9px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .inspector-empty { display: grid; min-height: 280px; align-content: center; justify-items: center; gap: 8px; color: #8fa8c5; font-size: 12px; text-align: center; }
  .inspector-empty span { color: #607996; font-size: 11px; }
  .inspector-orbit { display: grid; width: 45px; height: 45px; place-items: center; border: 1px solid rgba(155,140,255,.3); border-radius: 50%; color: #9b8cff; font-size: 20px; box-shadow: 0 0 24px rgba(155,140,255,.12); }
  .editor-form { display: grid; gap: 10px; overflow: auto; padding-right: 2px; }
  label { display: grid; gap: 5px; color: #7f9abb; font-size: 10px; }
  .field-hint { color: #526c8f; font-size: 9px; }
  input, select, textarea { width: 100%; border: 1px solid rgba(148,178,218,.16); border-radius: 7px; outline: none; background: rgba(6,16,29,.55); color: #dbeafa; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; transition: border-color .2s ease, box-shadow .2s ease; }
  input, select { min-height: 30px; padding: 6px 8px; }
  textarea { resize: vertical; padding: 7px 8px; line-height: 1.45; }
  input:focus, select:focus, textarea:focus { border-color: rgba(99,215,255,.55); box-shadow: 0 0 0 2px rgba(99,215,255,.08); }
  input:disabled, select:disabled, textarea:disabled { cursor: not-allowed; opacity: .65; }
</style>
