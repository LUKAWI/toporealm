<!-- ObjectDetail — 对象详情抽屉：稳定 ID / kind / 标题（payload.title）/ payload 全字段呈现；
     出入关系可跳转；appliesTo 模块命令来自目录真相（catalog），未知结构不崩溃。 -->
<script lang="ts">
  import { store, titleOf, displayOf } from "../store.svelte";
  import { kindColorOf, projectModuleKind } from "../moduleProjection";
  import DetailDrawer from "./DetailDrawer.svelte";
  import JsonSection from "./JsonSection.svelte";

  let visible = $state(false);
  let prevId: string | undefined;

  $effect(() => {
    const selection = store.selection;
    if (selection?.type === "object") {
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

  const object = $derived(store.selectedObject);
  const projection = $derived(object ? projectModuleKind(object.kind, store.catalog) : null);
  const outgoing = $derived(object ? store.relations.filter((relation) => relation.source === object.id) : []);
  const incoming = $derived(object ? store.relations.filter((relation) => relation.target === object.id) : []);

  let actionError = $state<{ code: string; message: string } | null>(null);
  let runningAction = $state<string | null>(null);

  // 模块命令：目录 id（ns.name）经 Session.run 执行，commits 由 store 按序回灌
  async function runAction(commandId: string): Promise<void> {
    if (!object || store.readOnly || runningAction) return;
    actionError = null;
    runningAction = commandId;
    try {
      const result = await store.run(commandId, { target: object.id, input: {} });
      const lastRev = result.commits?.at(-1)?.revision;
      store.actionMessage = `${result.message ?? `命令 ${commandId} 已执行`}${lastRev !== undefined ? ` · r${lastRev}` : ""}`;
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      actionError = { code: error?.code ?? "UNKNOWN", message: error?.message ?? "命令执行失败。" };
    } finally {
      runningAction = null;
    }
  }

  function jumpTo(id: string): void {
    store.select({ type: "object", id });
  }
</script>

{#if object}
  <DetailDrawer title="对象详情" open={visible} onclose={() => store.select(null)}>
    <h2 class="entity-title">{displayOf(object)}</h2>

    <div class="meta-grid">
      <span class="meta-tag id-tag">{object.id}</span>
      <span class="meta-tag"><span class="kind-dot" style="background: {kindColorOf(object.kind, store.catalog)}"></span>{object.kind}</span>
      <span class="meta-tag">r{store.revision}</span>
    </div>

    <div class="object-actions">
      <button class="action-btn" onclick={() => store.openEditor("edit-object", { targetId: object.id })} disabled={store.readOnly}>编辑</button>
      <button class="action-btn" onclick={() => store.openEditor("create-relation", { sourceId: object.id })} disabled={store.readOnly}>以此为起点创建关系</button>
    </div>

    {#if projection && !projection.available}
      <div class="degraded" role="note">
        <span class="degraded-tag">降级</span>
        模块 {projection.moduleId ?? "（未注册）"} 不可用：原始数据保持可读，依赖该模块的编辑与命令已禁用。
      </div>
    {/if}

    {#if titleOf(object)}
      <section class="section">
        <h3 class="section-title">标签</h3>
        <p class="plan-desc">{titleOf(object)}</p>
      </section>
    {/if}

    <section class="section">
      <h3 class="section-title">关系
        <span class="section-count">{outgoing.length + incoming.length}</span>
      </h3>
      {#if outgoing.length + incoming.length === 0}
        <p class="plan-desc">暂无关系——在画布上选择该对象后可从它创建第一条关系。</p>
      {:else}
        <div class="sub-list column">
          {#each outgoing as relation (relation.id)}
            <button class="relation-row" onclick={() => store.select({ type: "relation", id: relation.id })}>
              <span class="relation-dir">→</span>
              <span class="relation-name">{titleOf(relation) || relation.kind}</span>
              <span class="relation-endpoint">{relation.target}</span>
            </button>
          {/each}
          {#each incoming as relation (relation.id)}
            <button class="relation-row" onclick={() => store.select({ type: "relation", id: relation.id })}>
              <span class="relation-dir">←</span>
              <span class="relation-name">{titleOf(relation) || relation.kind}</span>
              <span class="relation-endpoint">{relation.source}</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    {#if projection && projection.commands.length > 0}
      <section class="section">
        <h3 class="section-title">模块命令</h3>
        <div class="sub-list">
          {#each projection.commands as command (command.commandId)}
            <button
              class="chip chip-link"
              title={command.title}
              onclick={() => runAction(command.commandId)}
              disabled={store.readOnly || runningAction !== null}
            >
              {runningAction === command.commandId ? "执行中…" : command.commandId}
            </button>
          {/each}
        </div>
        {#if actionError}
          <div class="action-error" role="alert">
            <span class="action-error-code">{actionError.code}</span>
            <span class="action-error-text">{actionError.message}</span>
          </div>
        {/if}
      </section>
    {/if}

    <section class="section">
      <h3 class="section-title">payload</h3>
      <JsonSection label="payload" value={object.payload} />
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

  .object-actions {
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

  .action-error {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-top: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: rgba(229, 80, 79, 0.1);
    border: 1px solid rgba(229, 80, 79, 0.4);
    border-radius: var(--r);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--status-failed);
  }

  .action-error-code {
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: var(--track-caps);
  }

  .action-error-text {
    color: var(--ink-muted);
    flex: 1;
    min-width: 0;
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

  .relation-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r);
    cursor: pointer;
    text-align: left;
    transition: background 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .relation-row:hover {
    background: var(--wash-2);
    border-color: var(--line-strong);
  }

  .relation-row:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .relation-dir {
    font-family: var(--font-mono);
    color: var(--ink-faint);
    flex-shrink: 0;
  }

  .relation-name {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .relation-endpoint {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    flex-shrink: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
