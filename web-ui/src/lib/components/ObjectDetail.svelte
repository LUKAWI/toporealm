<!-- ObjectDetail — 对象详情抽屉：稳定 ID / kind / 标题（payload.title）/ payload 全字段呈现；
     出入关系可跳转。D47 审阅转向：写面 = 写批注（对象/类）与 checkpoint 人工确认（√/×），
     通用编辑与模块命令区退场；批注对象（公共 kind，D48）有专属呈现与收口操作。 -->
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

  // D48：批注对象专属呈现与收口
  const isAnnotation = $derived(object?.kind === "annotation");
  const annotationTarget = $derived.by(() => {
    const raw = object?.payload?.["target"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const scope = (raw as Record<string, unknown>)["scope"];
    const ref = (raw as Record<string, unknown>)["ref"];
    return typeof scope === "string" && typeof ref === "string" ? { scope, ref } : null;
  });

  // D49：checkpoint 内嵌约定（§7 dogfood）；仅无终态决策的条目给 √/×，已决策只读展示
  const checkpoints = $derived.by(() => {
    const raw = object?.payload?.["checkpoints"];
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c) && typeof c["id"] === "string",
    );
  });
  const checkpointCmdAvailable = $derived((store.catalog?.commands ?? []).some((cmd) => cmd.id === "wf.record-checkpoint"));

  function checkpointDecided(entry: Record<string, unknown>): boolean {
    const status = entry["status"];
    return status === "passed" || status === "failed" || status === "skipped";
  }

  function checkpointLabel(entry: Record<string, unknown>): string {
    return typeof entry["label"] === "string" && entry["label"].trim() ? entry["label"] : String(entry["id"]);
  }

  function checkpointWho(entry: Record<string, unknown>): string {
    const by = typeof entry["by"] === "string" ? entry["by"] : "";
    const at = typeof entry["at"] === "string" ? entry["at"] : "";
    if (!by && !at) return "";
    return [by, at].filter(Boolean).join(" · ");
  }

  let actionError = $state<{ code: string; message: string } | null>(null);
  let runningAction = $state<string | null>(null);

  /** checkpoint 人工确认（D49）：走 wf.record-checkpoint，领域逻辑（状态机/钩子执法）留在模块。 */
  async function markCheckpoint(id: string, status: "passed" | "failed"): Promise<void> {
    if (!object || runningAction) return;
    actionError = null;
    runningAction = `checkpoint:${id}`;
    try {
      const result = await store.run("wf.record-checkpoint", {
        target: object.id,
        input: { id, status, actor: "user", by: "user" },
      });
      const lastRev = result.commits?.at(-1)?.revision;
      store.actionMessage = `检查点 ${id} → ${status === "passed" ? "通过" : "驳回"}${lastRev !== undefined ? ` · r${lastRev}` : ""}`;
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      actionError = { code: error?.code ?? "UNKNOWN", message: error?.message ?? "检查点提交失败。" };
    } finally {
      runningAction = null;
    }
  }

  /** 批注收口/重开（D48）：merge resolved 顶层布尔，resolvedAt 随置位写、复位删键。 */
  async function setResolved(resolved: boolean): Promise<void> {
    if (!object || runningAction) return;
    actionError = null;
    runningAction = "resolve";
    try {
      const result = await store.setAnnotationResolved(object.id, resolved);
      store.actionMessage = `${resolved ? "已标记解决" : "已重开"} · r${result.revision}`;
    } catch (cause) {
      const error = cause as { code?: string; message?: string };
      actionError = { code: error?.code ?? "UNKNOWN", message: error?.message ?? "操作失败。" };
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

    {#if isAnnotation}
      <div class="object-actions">
        <button class="action-btn" onclick={() => setResolved(true)} disabled={runningAction !== null}>
          {runningAction === "resolve" ? "提交中…" : "标记已解决"}
        </button>
        <button class="action-btn" onclick={() => setResolved(false)} disabled={runningAction !== null}>重开</button>
      </div>
    {:else}
      <div class="object-actions">
        <button class="action-btn" onclick={() => store.openComposer({ scope: "node", nodeId: object.id })}>写批注</button>
        <button class="action-btn" onclick={() => store.openComposer({ scope: "kind", kind: object.kind })}>为此类写批注</button>
      </div>
    {/if}

    {#if projection && !projection.available}
      <div class="degraded" role="note">
        <span class="degraded-tag">降级</span>
        模块 {projection.moduleId ?? "（未注册）"} 不可用：原始数据保持可读。
      </div>
    {/if}

    {#if isAnnotation}
      <section class="section">
        <h3 class="section-title">内容</h3>
        <p class="annotation-body">{typeof object.payload["body"] === "string" ? object.payload["body"] : "（空）"}</p>
      </section>
      <section class="section">
        <h3 class="section-title">属性</h3>
        <div class="annotation-meta">
          {#if typeof object.payload["motivation"] === "string"}
            <span class="meta-tag">{object.payload["motivation"] === "question" ? "提问" : object.payload["motivation"] === "assessing" ? "评审意见" : "评论"}</span>
          {/if}
          <span class="meta-tag">{object.payload["resolved"] === true ? "已解决" : "未解决"}</span>
          {#if typeof object.payload["author"] === "string"}
            <span class="meta-tag">{object.payload["author"]}</span>
          {/if}
          {#if typeof object.payload["created"] === "string"}
            <span class="meta-tag">{object.payload["created"].slice(0, 19).replace("T", " ")}</span>
          {/if}
        </div>
      </section>
      {#if annotationTarget}
        <section class="section">
          <h3 class="section-title">批注目标</h3>
          <div class="endpoint-row">
            <span class="endpoint-label">{annotationTarget.scope === "node" ? "对象" : annotationTarget.scope === "kind" ? "类" : "整图"}</span>
            {#if annotationTarget.scope === "node"}
              <button class="endpoint-link" onclick={() => jumpTo(annotationTarget.ref)}>{annotationTarget.ref}</button>
            {:else}
              <span class="target-static">{annotationTarget.ref}</span>
            {/if}
          </div>
        </section>
      {/if}
    {:else if titleOf(object)}
      <section class="section">
        <h3 class="section-title">标签</h3>
        <p class="plan-desc">{titleOf(object)}</p>
      </section>
    {/if}

    {#if !isAnnotation && checkpoints.length > 0}
      <section class="section">
        <h3 class="section-title">检查点
          <span class="section-count">{checkpoints.length}</span>
        </h3>
        {#if !checkpointCmdAvailable}
          <p class="checkpoint-hint">workflow 模块未装载：检查点仅供查看，无法人工确认。</p>
        {/if}
        <div class="checkpoint-list">
          {#each checkpoints as entry (String(entry["id"]))}
            <div class="checkpoint-row" class:decided={checkpointDecided(entry)}>
              <span class="checkpoint-status cp-{String(entry["status"] ?? "pending")}">
                {String(entry["status"]) === "passed" ? "✓" : String(entry["status"]) === "failed" ? "✕" : String(entry["status"]) === "skipped" ? "↷" : String(entry["status"]) === "running" ? "◐" : "○"}
              </span>
              <span class="checkpoint-label" title={String(entry["id"])}>{checkpointLabel(entry)}</span>
              {#if checkpointDecided(entry)}
                <span class="checkpoint-who">{checkpointWho(entry)}</span>
              {:else if checkpointCmdAvailable}
                <span class="checkpoint-actions">
                  <button class="cp-btn pass" onclick={() => markCheckpoint(String(entry["id"]), "passed")} disabled={runningAction !== null} title="人工确认通过">✓</button>
                  <button class="cp-btn fail" onclick={() => markCheckpoint(String(entry["id"]), "failed")} disabled={runningAction !== null} title="人工驳回">✕</button>
                </span>
              {/if}
            </div>
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
      <h3 class="section-title">关系
        <span class="section-count">{outgoing.length + incoming.length}</span>
      </h3>
      {#if outgoing.length + incoming.length === 0}
        <p class="plan-desc">暂无关系。</p>
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

  .annotation-body {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    line-height: 1.65;
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .annotation-meta {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }

  .target-static {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .checkpoint-hint {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--status-running);
    margin-bottom: var(--sp-2);
  }

  .checkpoint-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }

  .checkpoint-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
  }

  .checkpoint-row.decided {
    opacity: 0.75;
  }

  .checkpoint-status {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    flex-shrink: 0;
    width: 1.2em;
    text-align: center;
  }

  .checkpoint-status.cp-pending { color: var(--ink-faint); }
  .checkpoint-status.cp-running { color: var(--status-running); }
  .checkpoint-status.cp-passed { color: var(--status-ok, #34c98d); }
  .checkpoint-status.cp-failed { color: var(--status-failed); }
  .checkpoint-status.cp-skipped { color: var(--ink-faint); }

  .checkpoint-label {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--ink);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .checkpoint-who {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .checkpoint-actions {
    display: flex;
    gap: var(--sp-1);
    flex-shrink: 0;
  }

  .cp-btn {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--wash-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .cp-btn.pass:hover:not(:disabled) {
    background: rgba(52, 201, 141, 0.15);
    border-color: var(--status-ok, #34c98d);
    color: var(--status-ok, #34c98d);
  }

  .cp-btn.fail:hover:not(:disabled) {
    background: rgba(229, 80, 79, 0.12);
    border-color: var(--status-failed);
    color: var(--status-failed);
  }

  .cp-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .cp-btn:focus-visible {
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
