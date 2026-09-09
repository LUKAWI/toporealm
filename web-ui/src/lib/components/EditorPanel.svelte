<!--
  EditorPanel — 通用编辑抽屉：对象/关系的新增与修改（kind/label/data JSON/方向通用字段，
  模块声明字段仅作提示）、删除确认。提交统一 MutationPlan（expectedRevision 由 store 注入）；
  失败保留输入并显示稳定错误码；只读模式禁用全部写入口。
-->
<script lang="ts">
  import { store } from "../store.svelte";
  import { projectModuleKind } from "../moduleProjection";
  import type { GraphApiError, Mutation } from "../protocol";
  import DetailDrawer from "./DetailDrawer.svelte";
  import JsonSection from "./JsonSection.svelte";

  const editor = $derived(store.editor);
  const editingObject = $derived(editor?.mode === "edit-object" ? store.objects.find((object) => object.id === editor.targetId) : undefined);
  const editingRelation = $derived(editor?.mode === "edit-relation" ? store.relations.find((relation) => relation.id === editor.targetId) : undefined);

  let formId = $state("");
  let formKind = $state("");
  let formLabel = $state("");
  let formSource = $state("");
  let formTarget = $state("");
  let formDirection = $state<"directed" | "undirected">("directed");
  let formData = $state("");
  let submitting = $state(false);
  let formError = $state<{ code: string; message: string } | null>(null);
  let confirmDelete = $state(false);
  let loadedFor: string | null = null;

  const knownKinds = $derived([...new Set([...store.objects.map((object) => object.kind), ...store.relations.map((relation) => relation.kind)])].sort());
  const moduleHints = $derived(formKind.trim() ? projectModuleKind(formKind.trim(), store.moduleStatus).fields : []);

  // 编辑目标变化时预填表单（保留用户输入：仅当 target 变化才重置）
  $effect(() => {
    const current = store.editor;
    if (!current) {
      loadedFor = null;
      return;
    }
    const signature = `${current.mode}:${current.targetId ?? ""}:${current.sourceId ?? ""}`;
    if (loadedFor === signature) return;
    loadedFor = signature;
    formError = null;
    confirmDelete = false;
    if (current.mode === "create-object") {
      formId = ""; formKind = ""; formLabel = ""; formData = "";
    } else if (current.mode === "edit-object" && editingObject) {
      formId = editingObject.id; formKind = editingObject.kind; formLabel = editingObject.label; formData = editingObject.data ? JSON.stringify(editingObject.data, null, 2) : "";
    } else if (current.mode === "create-relation") {
      formId = ""; formKind = ""; formLabel = ""; formSource = current.sourceId ?? ""; formTarget = ""; formDirection = "directed"; formData = "";
    } else if (current.mode === "edit-relation" && editingRelation) {
      formId = editingRelation.id; formKind = editingRelation.kind; formLabel = editingRelation.label ?? "";
      formSource = editingRelation.source; formTarget = editingRelation.target;
      formDirection = editingRelation.direction; formData = editingRelation.data ? JSON.stringify(editingRelation.data, null, 2) : "";
    }
  });

  function parseData(): Record<string, unknown> | undefined {
    if (!formData.trim()) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(formData);
    } catch {
      throw { code: "INVALID_JSON", message: "data 必须是合法的 JSON 对象。" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw { code: "INVALID_JSON", message: "data 必须是 JSON 对象（不能是数组或标量）。" };
    }
    return parsed as Record<string, unknown>;
  }

  function requireField(value: string, label: string): string {
    if (!value.trim()) throw { code: "MISSING_FIELD", message: `${label}不能为空。` };
    return value.trim();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || !editor) return;
    formError = null;
    try {
      const data = parseData();
      const mutations: Mutation[] = [];
      if (editor.mode === "create-object" || editor.mode === "edit-object") {
        mutations.push({
          op: "upsert_object",
          object: {
            id: requireField(formId, "对象 ID"),
            kind: requireField(formKind, "kind"),
            label: formLabel.trim(),
            ...(data ? { data } : {}),
          },
        });
      } else {
        mutations.push({
          op: "upsert_relation",
          relation: {
            id: requireField(formId, "关系 ID"),
            kind: requireField(formKind, "kind"),
            source: requireField(formSource, "source"),
            target: requireField(formTarget, "target"),
            direction: formDirection,
            ...(formLabel.trim() ? { label: formLabel.trim() } : {}),
            ...(data ? { data } : {}),
          },
        });
      }
      submitting = true;
      const result = await store.commit({ mutations, label: editor.mode });
      const first = mutations[0];
      const savedId = first.op === "upsert_object" ? first.object.id : first.op === "upsert_relation" ? first.relation.id : "";
      store.actionMessage = `已保存 ${savedId} · r${result.snapshot.revision}`;
      store.select(first.op === "upsert_object" ? { type: "object", id: savedId } : { type: "relation", id: savedId });
      store.closeEditor();
    } catch (cause) {
      const error = cause as GraphApiError;
      formError = {
        code: error?.code ?? "UNKNOWN",
        message: error?.message ?? (cause instanceof Error ? cause.message : "提交失败，请稍后重试。"),
      };
    } finally {
      submitting = false;
    }
  }

  async function remove(): Promise<void> {
    if (!editor || !editor.targetId || submitting) return;
    formError = null;
    try {
      const op = editor.mode === "edit-object" ? "delete_object" : "delete_relation";
      const result = await store.commit({ mutations: [{ op, id: editor.targetId }], label: `delete ${editor.targetId}` });
      store.actionMessage = `已删除 ${editor.targetId} · r${result.snapshot.revision}`;
      if (store.selection?.id === editor.targetId) store.select(null);
      store.closeEditor();
    } catch (cause) {
      const error = cause as GraphApiError;
      formError = { code: error?.code ?? "UNKNOWN", message: error?.message ?? "删除失败。" };
    } finally {
      submitting = false;
      confirmDelete = false;
    }
  }

  async function reloadAfterRecovery(): Promise<void> {
    await store.reload();
    if (!store.error) formError = null;
  }
</script>

{#if editor}
  <DetailDrawer
    title={editor.mode === "create-object" ? "新增对象" : editor.mode === "edit-object" ? "编辑对象" : editor.mode === "create-relation" ? "新增关系" : "编辑关系"}
    open
    onclose={() => store.closeEditor()}
  >
    <form class="editor-form" onsubmit={submit}>
      {#if store.readOnly}
        <div class="readonly-note" role="note">只读模式：所有写入口已禁用。</div>
      {/if}

      <label class="field">
        <span class="field-label">{editor.mode.includes("relation") ? "关系 ID" : "对象 ID"}{editor.mode.startsWith("edit") ? "（不可变）" : ""}</span>
        <input class="field-input mono" type="text" bind:value={formId} disabled={store.readOnly || editor.mode.startsWith("edit")} required placeholder={editor.mode.includes("relation") ? "例如 rel-9" : "例如 note-9"} />
      </label>

      <label class="field">
        <span class="field-label">kind</span>
        <input class="field-input mono" type="text" bind:value={formKind} disabled={store.readOnly} required list="known-kinds" placeholder="例如 research.question" />
        <datalist id="known-kinds">
          {#each knownKinds as kind (kind)}
            <option value={kind}></option>
          {/each}
        </datalist>
        {#if moduleHints.length}
          <span class="field-hint">模块声明字段：{moduleHints.join("、")}（仅提示，不做领域解释）</span>
        {/if}
      </label>

      {#if editor.mode.includes("relation")}
        <div class="field-pair">
          <label class="field">
            <span class="field-label">source</span>
            <input class="field-input mono" type="text" bind:value={formSource} disabled={store.readOnly} required placeholder="起点对象 ID" />
          </label>
          <label class="field">
            <span class="field-label">target</span>
            <input class="field-input mono" type="text" bind:value={formTarget} disabled={store.readOnly} required placeholder="终点对象 ID" />
          </label>
        </div>
        <label class="field">
          <span class="field-label">方向</span>
          <select class="field-input" bind:value={formDirection} disabled={store.readOnly}>
            <option value="directed">有向（directed）</option>
            <option value="undirected">无向（undirected）</option>
          </select>
        </label>
      {/if}

      <label class="field">
        <span class="field-label">标签</span>
        <input class="field-input" type="text" bind:value={formLabel} disabled={store.readOnly} placeholder="可选的人类可读名称" />
      </label>

      <label class="field">
        <span class="field-label">data（JSON，可选）</span>
        <textarea class="field-input mono" rows="5" bind:value={formData} disabled={store.readOnly} placeholder='&#123;"key": "value"&#125;'></textarea>
      </label>

      {#if formError}
        <div class="form-error" role="alert">
          <span class="error-code">{formError.code}</span>
          <span class="error-text">{formError.message}</span>
          {#if formError.code === "REVISION_CONFLICT" || formError.code === "PATCH_GAP"}
            <button type="button" class="mini-btn" onclick={reloadAfterRecovery}>重新读取</button>
          {/if}
        </div>
      {/if}

      <div class="form-actions">
        <button class="primary-btn" type="submit" disabled={store.readOnly || submitting}>
          {submitting ? "提交中…" : editor.mode.startsWith("create") ? "创建" : "保存修改"}
        </button>
        <button class="ghost-btn" type="button" onclick={() => store.closeEditor()} disabled={submitting}>取消</button>
      </div>

      {#if editor.mode.startsWith("edit") && editor.targetId}
        <div class="danger-zone">
          {#if confirmDelete}
            <span class="confirm-text">确认删除 {editor.targetId}？{editor.mode === "edit-object" ? "其关联关系将按 Core 语义一并消失。" : ""}</span>
            <button class="danger-btn" type="button" onclick={remove} disabled={store.readOnly || submitting}>确认删除</button>
            <button class="ghost-btn" type="button" onclick={() => (confirmDelete = false)}>取消</button>
          {:else}
            <button class="danger-btn" type="button" onclick={() => (confirmDelete = true)} disabled={store.readOnly || submitting}>删除</button>
          {/if}
        </div>
      {/if}
    </form>
  </DetailDrawer>
{/if}

<style>
  .editor-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .readonly-note {
    padding: var(--sp-2) var(--sp-3);
    background: rgba(240, 167, 58, 0.1);
    border: 1px solid rgba(240, 167, 58, 0.3);
    border-radius: var(--r);
    color: var(--status-running);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .field-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    letter-spacing: 0.02em;
  }

  .field-input {
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    padding: var(--sp-2) var(--sp-3);
    outline: none;
    transition: border-color 0.13s var(--ease-out-quart), background 0.13s var(--ease-out-quart);
    width: 100%;
  }

  .field-input.mono {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .field-input:hover:not(:disabled) {
    border-color: var(--line-strong);
  }

  .field-input:focus:not(:disabled) {
    background: var(--wash-2);
    border-color: var(--line-strong);
  }

  .field-input:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .field-input::placeholder {
    color: var(--ink-faint);
  }

  select.field-input option {
    background: var(--bg-chrome);
    color: var(--ink);
  }

  textarea.field-input {
    resize: vertical;
    min-height: 80px;
    line-height: 1.55;
  }

  .field-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }

  .field-hint {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    line-height: 1.5;
  }

  .form-error {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding: var(--sp-2) var(--sp-3);
    background: rgba(229, 80, 79, 0.1);
    border: 1px solid rgba(229, 80, 79, 0.4);
    border-radius: var(--r);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--status-failed);
  }

  .error-code {
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: var(--track-caps);
  }

  .error-text {
    color: var(--ink-muted);
    flex: 1;
    min-width: 0;
  }

  .mini-btn {
    background: transparent;
    border: 1px solid rgba(229, 80, 79, 0.4);
    border-radius: var(--r-sm);
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 600;
    padding: 1px var(--sp-2);
    cursor: pointer;
  }

  .mini-btn:hover {
    color: var(--ink);
  }

  .form-actions {
    display: flex;
    gap: var(--sp-2);
  }

  .primary-btn {
    flex: 1;
    background: var(--interactive);
    color: #000000;
    border: none;
    border-radius: var(--r);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 650;
    padding: var(--sp-2) var(--sp-4);
    cursor: pointer;
    transition: opacity 0.13s var(--ease-out-quart);
  }

  .primary-btn:hover:not(:disabled) {
    opacity: 0.88;
  }

  .primary-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ghost-btn {
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--r);
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: var(--sp-2) var(--sp-4);
    cursor: pointer;
    transition: color 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .ghost-btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink-faint);
  }

  .ghost-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .primary-btn:focus-visible,
  .ghost-btn:focus-visible,
  .danger-btn:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .danger-zone {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding-top: var(--sp-3);
    border-top: 1px solid var(--line);
  }

  .confirm-text {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--status-failed);
    flex: 1;
    min-width: 100%;
  }

  .danger-btn {
    background: rgba(229, 80, 79, 0.12);
    border: 1px solid rgba(229, 80, 79, 0.4);
    border-radius: var(--r);
    color: var(--status-failed);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: var(--sp-2) var(--sp-4);
    cursor: pointer;
    transition: background 0.13s var(--ease-out-quart);
  }

  .danger-btn:hover:not(:disabled) {
    background: rgba(229, 80, 79, 0.2);
  }

  .danger-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
