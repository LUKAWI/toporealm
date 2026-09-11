<script lang="ts">
  // TopoRealm Web 编辑器外壳 — 与 Super Plumber 参考实现同构的深空玻璃仪器舱。
  // 数据流统一走 lib/store.svelte.ts（GraphSnapshot/MutationPlan/History + 冲突恢复）。
  import { onMount } from "svelte";
  import GraphCanvas from "./lib/GraphCanvas.svelte";
  import ObjectDetail from "./lib/components/ObjectDetail.svelte";
  import RelationDetail from "./lib/components/RelationDetail.svelte";
  import EditorPanel from "./lib/components/EditorPanel.svelte";
  import ModuleExtensions from "./lib/components/ModuleExtensions.svelte";
  import { store } from "./lib/store.svelte";
  import { filterGraphSnapshot } from "./lib/filter";
  import { kindColorOf } from "./lib/moduleProjection";

  const filtered = $derived(filterGraphSnapshot(store.snapshot, { query: store.searchQuery, kind: store.kindFilter }));

  const kindChips = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const object of store.objects) counts.set(object.kind, (counts.get(object.kind) ?? 0) + 1);
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => ({ kind, count, color: kindColorOf(kind, store.moduleStatus) }));
  });

  let openFlyout = $state<"graphs" | "validation" | "modules" | "raw" | null>(null);

  /** 搜索 Enter：选中并居中首个命中对象（与参考同语言）。 */
  function searchKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    const query = store.searchQuery.trim().toLowerCase();
    if (!query) return;
    const hit = store.objects.find((object) => `${object.id} ${object.kind} ${object.label}`.toLowerCase().includes(query));
    if (hit) {
      store.select({ type: "object", id: hit.id });
      store.locateNode(hit.id);
    }
  }

  function toggleFlyout(name: "graphs" | "validation" | "modules" | "raw"): void {
    openFlyout = openFlyout === name ? null : name;
  }

  function handleGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      // 逐层退出：编辑器 → 选中 → 浮层 → 过滤（与参考一致）
      if (store.editor) store.closeEditor();
      else if (store.selection) store.select(null);
      else if (openFlyout) openFlyout = null;
      else if (store.searchQuery || store.kindFilter) store.clearFilters();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      void store.undo();
    } else if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      void store.redo();
    }
  }

  onMount(() => {
    void store.load();
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="app">
  <!-- ── 仪器条（单排 48px）：品牌 + kind 过滤 + 搜索 + 统计 ── -->
  <header class="topbar">
    <div class="brand">
      <div class="brand-text">
        <span class="title">TopoRealm</span>
        {#if store.snapshot}
          <span class="graph-label" title={store.snapshot.manifest.label ?? store.snapshot.manifest.id}>
            {store.snapshot.manifest.label ?? store.snapshot.manifest.id} · r{store.revision}
          </span>
        {/if}
      </div>
    </div>

    {#if store.snapshot}
      <div class="status-bar" role="group" aria-label="按 kind 过滤（计数即图例）">
        <span class="sb-total"><span class="sb-n">{store.objects.length}</span> objects</span>
        {#each kindChips as chip (chip.kind)}
          <button
            class="sb-chip"
            class:zero={chip.count === 0}
            aria-pressed={store.kindFilter === chip.kind}
            onclick={() => (store.kindFilter = store.kindFilter === chip.kind ? "" : chip.kind)}
            title="点击只看 {chip.kind}"
          >
            <span class="sb-dot" style="background: {chip.color}"></span>
            <span class="sb-n">{chip.count}</span>
            <span class="sb-label">{chip.kind}</span>
          </button>
        {/each}
        {#if store.kindFilter || store.searchQuery.trim()}
          <button class="sb-clear" onclick={() => store.clearFilters()} title="清除全部过滤">清除</button>
        {/if}
      </div>
    {/if}

    <div class="topbar-right">
      <div class="search-box">
        <svg class="search-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="6" cy="6" r="4.2"/>
          <path d="M9.2 9.2 12.5 12.5" stroke-linecap="round"/>
        </svg>
        <input
          class="search-input"
          type="search"
          placeholder="搜索 ID / label / kind…"
          autocomplete="off"
          bind:value={store.searchQuery}
          onkeydown={searchKeydown}
          aria-label="搜索图对象"
        />
      </div>
      <div class="stats">
        <span class="stat">{store.objects.length}<span class="stat-unit">obj</span></span>
        <span class="stat-divider">·</span>
        <span class="stat">{store.relations.length}<span class="stat-unit">rel</span></span>
        <span class="stat-divider">·</span>
        <span class="stat">r{store.revision}</span>
        {#if store.readOnly}
          <span class="conn-off" title="只读模式：所有写操作入口已禁用">只读</span>
        {/if}
      </div>
    </div>
  </header>

  <!-- ── 主区：画布舞台 + 工具轨 ── -->
  <main class="main">
    {#if store.loading && !store.snapshot}
      <div class="loading-state">
        <div class="skeleton-graph">
          <div class="skeleton-node" style="left: 20%; top: 30%;"></div>
          <div class="skeleton-node" style="left: 45%; top: 25%;"></div>
          <div class="skeleton-node" style="left: 70%; top: 35%;"></div>
          <div class="skeleton-node" style="left: 30%; top: 60%;"></div>
          <div class="skeleton-node" style="left: 55%; top: 65%;"></div>
          <div class="skeleton-node" style="left: 80%; top: 55%;"></div>
          <svg class="skeleton-edges" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line x1="20" y1="30" x2="45" y2="25" class="skeleton-edge"/>
            <line x1="45" y1="25" x2="70" y2="35" class="skeleton-edge"/>
            <line x1="20" y1="30" x2="30" y2="60" class="skeleton-edge"/>
            <line x1="45" y1="25" x2="55" y2="65" class="skeleton-edge"/>
            <line x1="70" y1="35" x2="80" y2="55" class="skeleton-edge"/>
          </svg>
        </div>
        <p class="loading-text">正在连接 TopoRealm Core…</p>
      </div>
    {:else if store.error && !store.snapshot}
      <div class="error-state" role="alert">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="var(--status-failed)" stroke-width="1.5" aria-hidden="true">
          <path d="M8 32c6-8 12-8 16 0s10 8 16 0"/>
          <path d="M24 12v10M24 27v3"/>
          <circle cx="24" cy="38" r="1.6" fill="var(--status-failed)" stroke="none"/>
        </svg>
        <h3 class="error-title">图快照加载失败</h3>
        <p class="error-hint">{store.error}</p>
        <button class="retry-btn" onclick={() => store.load()}>重试</button>
      </div>
    {:else if store.snapshot}
      {#if store.objects.length === 0 && store.relations.length === 0}
        <div class="empty-state">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" aria-hidden="true">
            <circle cx="20" cy="20" r="6"/>
            <circle cx="60" cy="40" r="6"/>
            <circle cx="20" cy="60" r="6"/>
            <path d="M26 20h14M26 60h14M46 40H34" stroke-dasharray="4 3"/>
          </svg>
          <h3 class="empty-title">空拓扑</h3>
          <p class="empty-hint">通过编辑器或 CLI / MCP 添加第一个对象与关系</p>
        </div>
      {:else}
        <!-- 星空画布（交互契约见 web-ui/src/lib/GraphCanvas.interaction.md） -->
        <GraphCanvas />

        {#if store.searchQuery.trim() || store.kindFilter}
          <div class="filter-chip" role="status">
            过滤中：{filtered.objects.length}/{store.objects.length} 对象 · {filtered.relations.length}/{store.relations.length} 关系
            <button class="filter-clear" onclick={() => store.clearFilters()} aria-label="清除过滤">清除</button>
          </div>
        {/if}
      {/if}

      <!-- ── 浮动玻璃 dock（左缘，垂直居中）── -->
      <nav class="tool-rail" aria-label="画布工具轨">
        <button
          class="rail-btn"
          class:active={openFlyout === "graphs"}
          onclick={() => toggleFlyout("graphs")}
          title="图库（切换查看的图）"
          aria-label="图库"
          aria-expanded={openFlyout === "graphs"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 5.5 8 2.5l6 3-6 3-6-3Z"/>
            <path d="M2 8.5 8 11.5l6-3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2 11.5 8 14.5l6-3" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>
          </svg>
          {#if store.graphs.length > 1}
            <span class="rail-badge">{store.graphs.length}</span>
          {/if}
        </button>
        <button
          class="rail-btn"
          class:active={openFlyout === "validation"}
          onclick={() => toggleFlyout("validation")}
          title="校验（基础 / 完整）"
          aria-label="校验"
          aria-expanded={openFlyout === "validation"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 2 13.5 4.5V8c0 3-2.4 5.2-5.5 6-3.1-.8-5.5-3-5.5-6V4.5L8 2Z" stroke-linejoin="round"/>
            <path d="M5.8 8l1.6 1.6L10.5 6.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          class="rail-btn"
          class:active={openFlyout === "modules"}
          onclick={() => toggleFlyout("modules")}
          title="模块状态"
          aria-label="模块状态"
          aria-expanded={openFlyout === "modules"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/>
            <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/>
            <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/>
            <rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/>
          </svg>
        </button>
        <button
          class="rail-btn"
          class:active={openFlyout === "raw"}
          onclick={() => toggleFlyout("raw")}
          title="原始快照（JSON）"
          aria-label="原始快照"
          aria-expanded={openFlyout === "raw"}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        <span class="rail-sep" aria-hidden="true"></span>

        <button class="rail-btn" onclick={() => store.openEditor("create-object")} disabled={store.readOnly} title="新增对象" aria-label="新增对象">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5"/>
            <path d="M8 5.5v5M5.5 8h5" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="rail-btn" onclick={() => store.openEditor("create-relation")} disabled={store.readOnly} title="新增关系" aria-label="新增关系">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="3.5" cy="12" r="2"/>
            <circle cx="12.5" cy="4" r="2"/>
            <path d="M5.2 10.3 10.8 5.7" stroke-linecap="round"/>
          </svg>
        </button>

        <span class="rail-sep" aria-hidden="true"></span>

        <button class="rail-btn" onclick={() => store.undo()} disabled={store.readOnly || !store.history.canUndo} title="撤销（Ctrl+Z）" aria-label="撤销">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M6 3.5 3 6.5l3 3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 6.5h6a4 4 0 0 1 0 8H7" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="rail-btn" onclick={() => store.redo()} disabled={store.readOnly || !store.history.canRedo} title="重做（Ctrl+Y）" aria-label="重做">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M10 3.5l3 3-3 3" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M13 6.5H7a4 4 0 0 0 0 8h2" stroke-linecap="round"/>
          </svg>
        </button>

        <span class="rail-sep" aria-hidden="true"></span>

        <button class="rail-btn" onclick={() => store.requestZoom("in")} title="放大（+）" aria-label="放大">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 3v10M3 8h10"/>
          </svg>
        </button>
        <button class="rail-btn" onclick={() => store.requestZoom("out")} title="缩小（-）" aria-label="缩小">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M3 8h10"/>
          </svg>
        </button>
        <button class="rail-btn" onclick={() => store.requestZoom("fit")} title="适配全图（0）" aria-label="适配全图">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>
          </svg>
        </button>

        <span class="rail-sep" aria-hidden="true"></span>

        <button class="rail-btn" onclick={() => store.load()} title="重新读取快照" aria-label="刷新">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke-linecap="round"/>
            <path d="M13.5 1.5v3h-3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          class="rail-btn"
          class:active={store.readOnly}
          onclick={() => (store.readOnly = !store.readOnly)}
          title="只读模式（禁用所有写入口）"
          aria-label="只读模式"
          aria-pressed={store.readOnly}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="3" y="7.5" width="10" height="6" rx="1.5"/>
            <path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/>
          </svg>
        </button>
      </nav>

      {#if openFlyout === "graphs"}
        <aside class="rail-flyout graphs-flyout" aria-label="图库（切换查看的图）">
          <span class="flyout-title">图库</span>
          {#each store.graphs as gm (gm.id)}
            <button
              class="graph-item"
              class:active={gm.id === store.snapshot?.manifest.id}
              onclick={() => store.switchGraph(gm.id)}
              title={gm.label ?? gm.id}
            >
              <span class="graph-item-body">
                <span class="graph-item-name">{gm.label ?? gm.id}</span>
                <span class="graph-item-label">{gm.id} · r{gm.revision}</span>
              </span>
              <span class="graph-item-count">{gm.objectCount}</span>
            </button>
          {/each}
        </aside>
      {:else if openFlyout === "validation"}
        <aside class="rail-flyout validation-flyout" aria-label="校验">
          <span class="flyout-title">校验</span>
          <div class="flyout-actions">
            <button class="flyout-btn" onclick={() => store.runValidation("basic")}>基础校验</button>
            <button class="flyout-btn" onclick={() => store.runValidation("complete")}>完整校验</button>
          </div>
          {#if store.validation}
            <div class="validation-summary" class:valid={store.validation.ok} role="status">
              <span class="validation-verdict">{store.validation.ok ? "通过" : `${store.validation.errors.length} 个错误`} · {store.validation.complete ? "含模块注册" : "仅结构校验"}</span>
              {#if store.validation.errors.length}
                <ul class="validation-list errors">
                  {#each store.validation.errors as issue (issue.code + issue.message)}
                    <li>{issue.message}</li>
                  {/each}
                </ul>
              {/if}
              {#if store.validation.warnings.length}
                <ul class="validation-list warnings">
                  {#each store.validation.warnings as issue (issue.code + issue.message)}
                    <li>{issue.message}</li>
                  {/each}
                </ul>
              {/if}
            </div>
          {:else}
            <p class="flyout-hint">基础校验只查图结构；完整校验需模块注册参与。</p>
          {/if}
        </aside>
      {:else if openFlyout === "modules"}
        <aside class="rail-flyout modules-flyout" aria-label="模块状态">
          <span class="flyout-title">模块状态</span>
          {#if store.moduleStatus?.modules.length}
            {#each store.moduleStatus.modules as module (module.id)}
              <div class="module-item">
                <span class="module-dot" class:ok={module.status === "available"}></span>
                <span class="module-name">{module.namespace ?? module.id}</span>
                <span class="module-state" class:ok={module.status === "available"}>{module.status === "available" ? "可用" : "不可用"}</span>
                {#if module.reason}
                  <span class="module-reason">{module.reason}</span>
                {/if}
              </div>
            {/each}
          {:else}
            <p class="flyout-hint">暂无模块注册信息。</p>
          {/if}
        </aside>
      {:else if openFlyout === "raw"}
        <aside class="rail-flyout raw-flyout" aria-label="原始快照">
          <span class="flyout-title">原始快照</span>
          <pre class="raw-snapshot">{JSON.stringify(store.snapshot, null, 2)}</pre>
        </aside>
      {/if}
      <ModuleExtensions />
    {/if}

    {#if store.recovery}
      <div class="action-chip recovery" role="alert">
        <span class="recovery-code">{store.recovery.code}</span>
        <span class="recovery-text">{store.recovery.message} 本地视图未写入，可重新读取服务器快照。</span>
        <button class="filter-clear" onclick={() => store.reload()}>重新读取</button>
      </div>
    {:else if store.actionMessage}
      <div class="action-chip" role="status">
        {store.actionMessage}
        {#if store.error && store.snapshot}
          <button class="filter-clear" onclick={() => store.load()}>重新读取</button>
        {/if}
      </div>
    {/if}
  </main>

  <!-- 详情抽屉（右缘玻璃舱，画布点击 → 选择 → 内容渲染） -->
  <ObjectDetail />
  <RelationDetail />
  <EditorPanel />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg-chrome);
    color: var(--ink);
    overflow: hidden;
  }

  /* ── 仪器条（单排 48px）：任何宽度不叠两栏；拥挤时过滤组横向滚动 ── */
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0 var(--sp-4);
    height: 48px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--line);
    box-shadow: inset 0 1px 0 var(--hi-line);
    background: var(--bg-chrome);
    user-select: none;
    white-space: nowrap;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--ink-muted);
    flex-shrink: 0;
  }

  .brand-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .title {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--ink);
    line-height: 1.2;
  }

  .graph-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    letter-spacing: 0.02em;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 可点 kind chips：分段容器（计数即图例，点击即过滤）；拥挤时整组横向滚动 */
  .status-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: var(--wash-1);
    border-radius: 11px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    flex-shrink: 1;
  }

  .status-bar::-webkit-scrollbar {
    display: none;
  }

  .sb-total {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-muted);
    padding: 3px var(--sp-2);
    font-variant-numeric: tabular-nums;
    align-self: center;
    flex-shrink: 0;
  }

  .sb-n {
    color: var(--ink);
    font-weight: 600;
  }

  .sb-total .sb-n {
    margin-right: 3px;
  }

  .sb-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-muted);
    background: transparent;
    border: none;
    border-radius: 999px;
    padding: 3px 9px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    transition: background 0.13s var(--ease-out-quart), color 0.13s var(--ease-out-quart);
  }

  .sb-chip:hover {
    background: var(--wash-2);
    color: var(--ink);
  }

  .sb-chip[aria-pressed="true"] {
    background: var(--wash-3);
    color: var(--ink);
  }

  .sb-chip:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .sb-chip.zero {
    opacity: 0.45;
  }

  .sb-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .sb-label {
    letter-spacing: 0.02em;
  }

  .sb-clear {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--ink);
    background: var(--wash-3);
    border: none;
    border-radius: 999px;
    padding: 3px 10px;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.13s var(--ease-out-quart);
  }

  .sb-clear:hover {
    background: rgba(255, 255, 255, 0.18);
  }

  .sb-clear:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .topbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
  }

  .stats {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding-left: var(--sp-2);
  }

  .stat {
    color: var(--ink);
    font-weight: 500;
  }

  .stat-unit {
    color: var(--ink-faint);
    margin-left: 1px;
  }

  .stat-divider {
    color: var(--ink-faint);
  }

  .conn-off {
    color: var(--status-running);
    font-size: var(--text-2xs);
    border: 1px solid rgba(240, 167, 58, 0.5);
    border-radius: 999px;
    padding: 1px var(--sp-2);
  }

  /* 搜索：图标内嵌的胶囊输入 */
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 10px;
    color: var(--ink-faint);
    pointer-events: none;
  }

  .search-input {
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    padding: 5px var(--sp-2) 5px 28px;
    width: 210px;
    outline: none;
    transition: border-color 0.13s var(--ease-out-quart), background 0.13s var(--ease-out-quart);
  }

  .search-input::placeholder {
    color: var(--ink-faint);
  }

  .search-input:hover {
    border-color: var(--line-strong);
  }

  .search-input:focus {
    background: var(--wash-2);
    border-color: var(--line-strong);
  }

  .search-input:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  /* ── 主区 ── */
  .main {
    flex: 1 1 0%;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  /* 过滤 / 操作提示 / 冲突恢复徽章（画布顶部或底部居中） */
  .filter-chip,
  .action-chip {
    position: absolute;
    top: var(--sp-3);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--glass);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line);
    border-radius: 999px;
    box-shadow: var(--shadow-float);
    padding: var(--sp-1) var(--sp-3);
    font-size: var(--text-2xs);
    font-family: var(--font-mono);
    color: var(--ink);
    z-index: var(--z-overlay);
    font-variant-numeric: tabular-nums;
    max-width: calc(100% - 48px);
  }

  .action-chip {
    top: auto;
    bottom: var(--sp-4);
  }

  .action-chip.recovery {
    border-color: rgba(229, 80, 79, 0.45);
  }

  .recovery-code {
    color: var(--status-failed);
    font-weight: 700;
    letter-spacing: var(--track-caps);
  }

  .recovery-text {
    font-family: var(--font-sans);
    color: var(--ink-muted);
  }

  .filter-clear {
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-sm);
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 600;
    padding: 1px var(--sp-2);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .filter-clear:hover {
    color: var(--ink);
    border-color: var(--ink-faint);
  }

  /* ── 浮动玻璃 dock（左缘，垂直居中）── */
  .tool-rail {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: var(--rail-w);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 0;
    background: var(--glass);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line, var(--line));
    border-radius: 16px;
    box-shadow: var(--shadow-float), inset 0 1px 0 var(--hi-line);
    z-index: var(--z-overlay);
    transition: transform 0.22s var(--ease-out-quint), opacity 0.22s var(--ease-out-quint);
  }

  .rail-btn {
    position: relative;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: var(--r);
    color: var(--ink-muted);
    cursor: pointer;
    transition: background 0.13s var(--ease-out-quart), color 0.13s var(--ease-out-quart);
  }

  .rail-btn:hover {
    background: var(--wash-2);
    color: var(--ink);
  }

  .rail-btn.active {
    background: var(--wash-3);
    color: var(--ink);
  }

  .rail-btn:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .rail-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .rail-badge {
    position: absolute;
    top: 3px;
    right: 3px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--wash-3);
    border: 1px solid var(--line-strong);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    line-height: 12px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .rail-sep {
    width: 18px;
    height: 1px;
    background: var(--line);
    margin: var(--sp-1) 0;
    flex-shrink: 0;
  }

  /* dock 旁的玻璃浮层 */
  .rail-flyout {
    position: absolute;
    left: calc(var(--rail-w) + 20px);
    top: 50%;
    transform: translateY(-50%);
    background: var(--glass-strong);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line, var(--line));
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-float), inset 0 1px 0 var(--hi-line);
    padding: var(--sp-3);
    z-index: var(--z-panel);
    min-width: 210px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    max-height: 70vh;
    overflow-y: auto;
  }

  .graphs-flyout {
    min-width: 260px;
  }

  .raw-flyout {
    min-width: 380px;
    max-width: 480px;
  }

  .flyout-title {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 650;
    color: var(--ink-faint);
    padding: 0 var(--sp-1) var(--sp-1);
  }

  .flyout-hint {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    line-height: 1.6;
    margin: 0;
    padding: 0 var(--sp-1);
  }

  .flyout-actions {
    display: flex;
    gap: var(--sp-2);
    padding: 0 var(--sp-1) var(--sp-1);
  }

  .flyout-btn {
    flex: 1;
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

  .flyout-btn:hover {
    background: var(--wash-3);
  }

  .flyout-btn:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .graph-item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-2);
    border: none;
    background: transparent;
    border-radius: var(--r);
    cursor: pointer;
    text-align: left;
    transition: background 0.13s var(--ease-out-quart);
  }

  .graph-item:hover {
    background: var(--wash-2);
  }

  .graph-item.active {
    background: var(--wash-3);
  }

  .graph-item:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .graph-item-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }

  .graph-item-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .graph-item-label {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .graph-item-count {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    background: var(--wash-2);
    border-radius: 999px;
    padding: 1px 8px;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .validation-summary {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: rgba(229, 80, 79, 0.08);
    border: 1px solid rgba(229, 80, 79, 0.35);
    border-radius: var(--r);
  }

  .validation-summary.valid {
    background: rgba(22, 163, 74, 0.08);
    border-color: rgba(22, 163, 74, 0.35);
  }

  .validation-verdict {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--status-failed);
  }

  .validation-summary.valid .validation-verdict {
    color: var(--status-passed);
  }

  .validation-list {
    margin: 0;
    padding-left: var(--sp-4);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    line-height: 1.6;
    color: var(--ink-muted);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .validation-list.errors {
    color: var(--status-failed);
  }

  .validation-list.warnings {
    color: var(--status-running);
  }

  .module-item {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-1);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-muted);
    flex-wrap: wrap;
  }

  .module-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--status-failed);
    flex-shrink: 0;
  }

  .module-dot.ok {
    background: var(--status-passed);
  }

  .module-name {
    color: var(--ink);
  }

  .module-state {
    margin-left: auto;
    color: var(--status-failed);
  }

  .module-state.ok {
    color: var(--status-passed);
  }

  .module-reason {
    flex-basis: 100%;
    color: var(--ink-faint);
    padding-left: var(--sp-3);
  }

  .raw-snapshot {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
    color: var(--ink-muted);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 50vh;
    overflow-y: auto;
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r);
    padding: var(--sp-2);
  }

  /* ── 加载 / 空态 / 错误态 ── */
  .loading-state,
  .empty-state,
  .error-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    color: var(--ink-muted);
    background: var(--bg);
  }

  .skeleton-graph {
    position: relative;
    width: 400px;
    height: 300px;
    opacity: 0.4;
  }

  .skeleton-node {
    position: absolute;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--surface-2);
    border: 2px solid var(--line-strong);
    animation: skeleton-pulse 1.5s ease-in-out infinite;
  }

  .skeleton-node:nth-child(1) { animation-delay: 0s; }
  .skeleton-node:nth-child(2) { animation-delay: 0.1s; }
  .skeleton-node:nth-child(3) { animation-delay: 0.2s; }
  .skeleton-node:nth-child(4) { animation-delay: 0.3s; }
  .skeleton-node:nth-child(5) { animation-delay: 0.4s; }
  .skeleton-node:nth-child(6) { animation-delay: 0.5s; }

  .skeleton-edges {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .skeleton-edge {
    stroke: var(--line-strong);
    stroke-width: 0.5;
    stroke-dasharray: 2 1;
    animation: skeleton-pulse 1.5s ease-in-out infinite;
  }

  .skeleton-edge:nth-child(1) { animation-delay: 0.1s; }
  .skeleton-edge:nth-child(2) { animation-delay: 0.2s; }
  .skeleton-edge:nth-child(3) { animation-delay: 0.3s; }
  .skeleton-edge:nth-child(4) { animation-delay: 0.4s; }
  .skeleton-edge:nth-child(5) { animation-delay: 0.5s; }

  @keyframes skeleton-pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.6; }
  }

  .loading-text {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--ink-muted);
    margin: 0;
  }

  .error-title {
    font-family: var(--font-sans);
    font-size: var(--text-base);
    font-weight: 650;
    color: var(--ink);
    margin: 0;
  }

  .error-hint {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--ink-faint);
    margin: 0;
    max-width: 44ch;
    text-align: center;
    line-height: 1.6;
  }

  .retry-btn {
    background: var(--interactive);
    color: #000000;
    border: none;
    border-radius: var(--r);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 600;
    padding: var(--sp-2) var(--sp-4);
    cursor: pointer;
    transition: opacity 0.13s var(--ease-out-quart);
  }

  .retry-btn:hover {
    opacity: 0.88;
  }

  .empty-title {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 650;
    margin: var(--sp-2) 0 0;
    color: var(--ink-muted);
  }

  .empty-hint {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    margin: 0;
    color: var(--ink-faint);
  }

  /* ── Reduced motion ── */
  @media (prefers-reduced-motion: reduce) {
    .sb-chip, .rail-btn, .tool-rail, .rail-flyout { transition: none; }
    .skeleton-node, .skeleton-edge { animation: none; opacity: 0.5; }
  }

  /* ── Responsive：单排仪器条收紧（过滤组横向滚动）── */
  @media (max-width: 768px) {
    .topbar {
      padding: 0 var(--sp-3);
      gap: var(--sp-2);
    }
    .stats { display: none; }
    .graph-label { display: none; }
    .search-input { width: 130px; }

    .tool-rail {
      top: auto;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      width: auto;
      height: 56px;
      flex-direction: row;
      padding: 0 8px;
      border-radius: 18px;
    }
    .rail-btn { width: var(--tap); height: var(--tap); }
    .rail-sep { width: 1px; height: 20px; margin: 0 var(--sp-1); }
    .rail-flyout {
      left: var(--sp-2);
      right: var(--sp-2);
      top: auto;
      bottom: calc(56px + 20px);
      transform: none;
    }
  }
</style>
