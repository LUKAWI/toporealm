<!-- JsonSection — 抽屉内的原始 JSON 折叠块（含复制按钮）；未知 kind/缺失模块时仍完整呈现原始数据。 -->
<script lang="ts">
  let { label, value }: { label: string; value: unknown } = $props();

  let open = $state(false);
  let copied = $state(false);
  const text = $derived(value === undefined ? "" : JSON.stringify(value, null, 2));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
</script>

<div class="json-block">
  <div class="json-head">
    <button class="json-toggle" onclick={() => (open = !open)} aria-expanded={open}>
      <svg class:open width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M2.5 1 6.5 4.5 2.5 8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      {label}
    </button>
    {#if open}
      <button class="json-copy" onclick={copy}>{copied ? "已复制" : "复制"}</button>
    {/if}
  </div>
  {#if open}
    <pre class="json-body">{text}</pre>
  {/if}
</div>

<style>
  .json-block {
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--wash-1);
    margin-bottom: var(--sp-2);
    overflow: hidden;
  }

  .json-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .json-toggle {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
    background: none;
    border: none;
    color: var(--ink-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 600;
    padding: var(--sp-2) var(--sp-3);
    cursor: pointer;
    text-align: left;
    transition: background 0.13s var(--ease-out-quart), color 0.13s var(--ease-out-quart);
  }

  .json-toggle:hover {
    background: var(--wash-2);
    color: var(--ink);
  }

  .json-toggle:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: -2px;
  }

  .json-toggle svg {
    transition: transform 0.15s var(--ease-out-quart);
    flex-shrink: 0;
  }

  .json-toggle svg.open {
    transform: rotate(90deg);
  }

  .json-copy {
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-sm);
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 600;
    padding: 2px var(--sp-2);
    margin-right: var(--sp-2);
    cursor: pointer;
    transition: color 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .json-copy:hover {
    color: var(--ink);
    border-color: var(--ink-faint);
  }

  .json-body {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.55;
    color: var(--ink-muted);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
    border-top: 1px solid var(--line);
  }
</style>
