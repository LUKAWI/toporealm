<!--
  AnnotationComposer — 批注撰写抽屉（D47/D48）：WebUI 唯一的自由写面。
  目标由 store.composer 决定（整图/类/对象），用户只写内容与意图——无 ID、无 kind、
  无 JSON 字段。提交 = put annotation 对象（+ node 锚定的 annotation_of 挂靠边），
  同一提交原子生效；失败保留输入并显示稳定错误码。
-->
<script lang="ts">
  import { store, displayOf } from "../store.svelte";
  import DetailDrawer from "./DetailDrawer.svelte";

  const composer = $derived(store.composer);

  let body = $state("");
  let motivation = $state<"comment" | "question" | "assessing">("comment");
  let submitting = $state(false);
  let formError = $state<{ code: string; message: string } | null>(null);
  let loadedFor = $state("");

  // 目标切换时清空输入（保留用户输入仅在错误重试场景——同一目标 signature 不重置）
  $effect(() => {
    const current = store.composer;
    if (!current) return;
    const signature = current.scope === "node" ? `node:${current.nodeId}` : current.scope === "kind" ? `kind:${current.kind}` : "graph";
    if (loadedFor === signature) return;
    loadedFor = signature;
    body = "";
    motivation = "comment";
    formError = null;
  });

  const targetLabel = $derived.by(() => {
    const current = store.composer;
    if (!current) return "";
    if (current.scope === "graph") return "整张图";
    if (current.scope === "kind") return `类 ${current.kind}`;
    const node = store.objects.find((object) => object.id === current.nodeId);
    return `对象 ${node ? displayOf(node) : current.nodeId}`;
  });

  const motivations = [
    { value: "comment", label: "评论" },
    { value: "question", label: "提问" },
    { value: "assessing", label: "评审意见" },
  ] as const;

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = store.composer;
    if (submitting || !current) return;
    formError = null;
    const trimmed = body.trim();
    if (!trimmed) {
      formError = { code: "EMPTY_BODY", message: "批注内容不能为空。" };
      return;
    }
    const ref = current.scope === "node" ? current.nodeId : current.scope === "kind" ? `kind:${current.kind}` : "graph";
    submitting = true;
    try {
      const result = await store.annotate({ scope: current.scope, ref, body: trimmed, motivation });
      store.actionMessage = `批注已提交 · r${result.revision}`;
      store.closeComposer();
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      formError = {
        code: error?.code ?? "UNKNOWN",
        message: error?.message ?? (cause instanceof Error ? cause.message : "提交失败，请稍后重试。"),
      };
    } finally {
      submitting = false;
    }
  }
</script>

{#if composer}
  <DetailDrawer title="写批注" open onclose={() => store.closeComposer()}>
    <form class="composer-form" onsubmit={submit}>
      <div class="target-row">
        <span class="target-tag">{targetLabel}</span>
      </div>

      <div class="motivation-row" role="radiogroup" aria-label="批注类型">
        {#each motivations as m (m.value)}
          <button
            type="button"
            class="motivation-chip"
            class:active={motivation === m.value}
            aria-pressed={motivation === m.value}
            onclick={() => (motivation = m.value)}
          >{m.label}</button>
        {/each}
      </div>

      <label class="field">
        <span class="field-label">批注内容</span>
        <textarea
          class="field-input mono"
          rows="5"
          bind:value={body}
          placeholder="写给 agent 看的意见——它会被精准带回给执行侧"
        ></textarea>
      </label>

      {#if formError}
        <div class="form-error" role="alert">
          <span class="error-code">{formError.code}</span>
          <span class="error-text">{formError.message}</span>
        </div>
      {/if}

      <div class="form-actions">
        <button class="primary-btn" type="submit" disabled={submitting}>
          {submitting ? "提交中…" : "提交批注"}
        </button>
        <button class="ghost-btn" type="button" onclick={() => store.closeComposer()} disabled={submitting}>取消</button>
      </div>
    </form>
  </DetailDrawer>
{/if}

<style>
  .composer-form {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .target-row {
    display: flex;
  }

  .target-tag {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--ink-muted);
    background: var(--wash-2);
    border: 1px solid var(--line);
    border-radius: var(--r);
    padding: var(--sp-1) var(--sp-2);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .motivation-row {
    display: flex;
    gap: var(--sp-2);
  }

  .motivation-chip {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 3px var(--sp-3);
    cursor: pointer;
    transition: color 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart), background 0.13s var(--ease-out-quart);
  }

  .motivation-chip:hover {
    color: var(--ink);
    border-color: var(--line-strong);
  }

  .motivation-chip.active {
    background: var(--wash-3);
    border-color: var(--interactive);
    color: var(--ink);
  }

  .motivation-chip:focus-visible,
  .primary-btn:focus-visible,
  .ghost-btn:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
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

  .field-input:focus {
    background: var(--wash-2);
    border-color: var(--line-strong);
  }

  textarea.field-input {
    resize: vertical;
    min-height: 96px;
    line-height: 1.55;
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
</style>
