<!-- RelationDetail — 关系详情抽屉：kind / 方向 / label / 端点跳转 / data / capabilities / meta。 -->
<script lang="ts">
  import { store } from "../store.svelte";
  import { kindColorOf, projectModuleKind } from "../moduleProjection";
  import DetailDrawer from "./DetailDrawer.svelte";
  import JsonSection from "./JsonSection.svelte";

  let visible = $state(false);
  let prevId: string | undefined;

  $effect(() => {
    const selection = store.selection;
    if (selection?.type === "relation") {
      if (selection.id !== prevId) {
        visible = false;
        requestAnimationFrame(() => (visible = true));
        prevId = selection.id;
      }
    } else {
      visible = false;
      prevId = undefined;
    }
  });

  const relation = $derived(store.selectedRelation);
  const projection = $derived(relation ? projectModuleKind(relation.kind, store.moduleStatus) : null);

  function jumpToObject(id: string): void {
    store.select({ type: "object", id });
  }
</script>

{#if relation}
  <DetailDrawer title="关系详情" open={visible} width={360} onclose={() => store.select(null)}>
    <h2 class="entity-title">{relation.label ?? relation.kind}</h2>

    <div class="meta-grid">
      <span class="meta-tag id-tag">{relation.id}</span>
      <span class="meta-tag"><span class="kind-dot" style="background: {kindColorOf(relation.kind, store.moduleStatus)}"></span>{relation.kind}</span>
      <span class="meta-tag">{relation.direction === "undirected" ? "无向" : "有向"}{relation.direction === "directed" ? " →" : ""}</span>
    </div>

    <div class="relation-actions">
      <button class="action-btn" onclick={() => store.openEditor("edit-relation", { targetId: relation.id })} disabled={store.readOnly}>编辑</button>
      <button class="action-btn" onclick={() => store.openEditor("edit-object", { targetId: relation.source })} disabled={store.readOnly}>编辑 source 对象</button>
    </div>

    {#if projection && !projection.available}
      <div class="degraded" role="note">
        <span class="degraded-tag">降级</span>
        模块 {projection.moduleId ?? "（未注册）"} 不可用：{projection.reason ?? "原始数据保持可读。"}
      </div>
    {/if}

    <section class="section">
      <h3 class="section-title">端点</h3>
      <div class="endpoint-row">
        <span class="endpoint-label">source</span>
        <button class="endpoint-link" onclick={() => jumpToObject(relation.source)}>{relation.source}</button>
      </div>
      <div class="endpoint-row">
        <span class="endpoint-label">target</span>
        <button class="endpoint-link" onclick={() => jumpToObject(relation.target)}>{relation.target}</button>
      </div>
    </section>

    {#if relation.label}
      <section class="section">
        <h3 class="section-title">标签</h3>
        <p class="plan-desc">{relation.label}</p>
      </section>
    {/if}

    <section class="section">
      <h3 class="section-title">关系数据</h3>
      <JsonSection label="data" value={relation.data} />
      <JsonSection label="capabilities" value={relation.capabilities} />
      <JsonSection label="meta" value={relation.meta} />
    </section>
  </DetailDrawer>
{/if}

<style>
  .kind-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .relation-actions {
    display: flex;
    gap: var(--sp-2);
    margin-bottom: var(--sp-4);
  }

  .action-btn {
    background: var(--wash-2);
    border: 1px solid var(--line);
    border-radius: var(--r);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    transition: background 0.13s var(--ease-out-quart);
  }

  .action-btn:hover:not(:disabled) {
    background: var(--wash-3);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .action-btn:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .degraded {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    margin-bottom: var(--sp-4);
    padding: var(--sp-3);
    background: rgba(240, 167, 58, 0.1);
    border: 1px solid rgba(240, 167, 58, 0.3);
    border-radius: var(--r);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    line-height: 1.6;
    color: var(--status-running);
  }

  .degraded-tag {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 700;
    letter-spacing: var(--track-caps);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .endpoint-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-2);
  }

  .endpoint-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    text-transform: lowercase;
    letter-spacing: 0.02em;
    width: 44px;
    flex-shrink: 0;
  }

  .endpoint-link {
    background: none;
    border: none;
    padding: 0;
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: var(--line-strong);
    text-underline-offset: 3px;
    transition: text-decoration-color 0.13s var(--ease-out-quart);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .endpoint-link:hover {
    text-decoration-color: var(--ink);
  }

  .endpoint-link:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }
</style>
