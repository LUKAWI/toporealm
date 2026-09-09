<!--
  DetailDrawer — 右缘悬浮玻璃抽屉的共享舱体（与 Super Plumber 参考实现同构）。
  对象/关系/校验等详情共用同一壳：头部（标题+Esc 提示+关闭）、玻璃面板几何、
  通用小节排版（section/chip/meta 类经 :global 下放，单一真相源）。
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    open,
    width = 400,
    onclose,
    children,
  }: {
    title: string;
    open: boolean;
    width?: number;
    onclose: () => void;
    children: Snippet;
  } = $props();
</script>

<div class="drawer" class:visible={open} style:width="{width}px">
  <div class="drawer-header">
    <span class="drawer-title">{title}</span>
    <span class="drawer-kbd">Esc 关闭</span>
    <button class="drawer-close" onclick={onclose} aria-label="关闭">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M3.5 3.5l8 8M11.5 3.5l-8 8" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  <div class="drawer-body">
    {@render children()}
  </div>
</div>

<style>
  /* 悬浮玻璃抽屉：不贴边、圆角舱门，与星空之间留出呼吸 */
  .drawer {
    position: fixed;
    right: 12px;
    top: calc(var(--header-h) + 12px);
    bottom: 12px;
    background: var(--glass-strong);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-float);
    color: var(--ink);
    display: flex;
    flex-direction: column;
    z-index: var(--z-panel);
    overflow: hidden;
    transform: translateX(calc(100% + 24px));
    transition: transform 0.22s var(--ease-out-quint);
  }

  .drawer.visible {
    transform: translateX(0);
  }

  .drawer-header {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 0 var(--sp-3) 0 var(--sp-5);
    min-height: 52px;
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
  }

  .drawer-title {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 650;
    color: var(--ink);
    flex: 1;
  }

  .drawer-kbd {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 1px var(--sp-1);
  }

  .drawer-close {
    background: none;
    border: none;
    color: var(--ink-muted);
    cursor: pointer;
    border-radius: var(--r);
    min-width: var(--tap);
    min-height: var(--tap);
    margin-right: calc((var(--tap) - 32px) / -2);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.13s var(--ease-out-quart), color 0.13s var(--ease-out-quart);
  }

  .drawer-close:hover {
    background: var(--wash-2);
    color: var(--ink);
  }

  .drawer-close:active {
    background: var(--wash-3);
  }

  .drawer-body {
    padding: var(--sp-5);
    overflow-y: auto;
    flex: 1;
  }

  /* ── 通用内容排版（子组件共用的单一真相源）── */

  /* 大标题 */
  .drawer-body :global(.entity-title) {
    font-family: var(--font-sans);
    font-size: var(--text-xl);
    font-weight: 700;
    margin: 0 0 var(--sp-4);
    color: var(--ink);
    line-height: 1.25;
    letter-spacing: var(--track-tight);
    text-wrap: balance;
  }

  /* meta chips 行 */
  .drawer-body :global(.meta-grid) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-bottom: var(--sp-5);
    padding-bottom: var(--sp-4);
    border-bottom: 1px solid var(--line);
  }

  .drawer-body :global(.meta-tag) {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    padding: 4px 10px;
    border-radius: 8px;
    background: var(--wash-1);
    color: var(--ink-muted);
    border: 1px solid var(--line);
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    letter-spacing: 0.02em;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drawer-body :global(.id-tag) {
    color: var(--ink);
    border-color: var(--line-strong);
    background: var(--wash-2);
  }

  /* 小节 */
  .drawer-body :global(.section) {
    margin-bottom: var(--sp-5);
    padding-top: var(--sp-3);
    border-top: 1px solid var(--line);
  }

  .drawer-body :global(.section-title) {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 650;
    margin: 0 0 var(--sp-3);
    color: var(--ink);
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }

  .drawer-body :global(.section-count) {
    margin-left: auto;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    background: var(--wash-1);
    border-radius: 999px;
    padding: 1px 8px;
  }

  .drawer-body :global(.plan-desc) {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    line-height: 1.7;
    color: var(--ink-muted);
    margin: 0;
  }

  /* 数据 chips */
  .drawer-body :global(.chip) {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    background: var(--wash-1);
    padding: 4px 10px;
    border-radius: 8px;
    color: var(--ink-muted);
    border: 1px solid var(--line);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drawer-body :global(.chip-link) {
    cursor: pointer;
    transition: background 0.13s var(--ease-out-quart), color 0.13s var(--ease-out-quart);
  }

  .drawer-body :global(.chip-link:hover) {
    background: var(--wash-3);
    color: var(--ink);
  }

  .drawer-body :global(.sub-list) {
    margin-top: var(--sp-3);
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    align-items: center;
  }

  .drawer-body :global(.sub-list.column) {
    flex-direction: column;
    align-items: stretch;
  }

  .drawer-body :global(.sub-label) {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
  }

  /* Responsive */
  @media (max-width: 1000px) {
    /* header 不会换行（单排 + 横向滚动），此断点仅收窄留更多画布 */
    .drawer { top: 12px; }
  }

  @media (max-width: 768px) {
    .drawer {
      width: auto !important;
      max-width: 100%;
      left: 12px;
      top: 12px;
      bottom: calc(56px + 20px);
      transform: translateY(calc(100% + 24px));
    }
    .drawer.visible {
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .drawer {
      transition: none;
    }
  }
</style>
