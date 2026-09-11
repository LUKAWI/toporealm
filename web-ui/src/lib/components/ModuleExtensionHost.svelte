<script lang="ts">
  import { onMount } from "svelte";
  import type { ActionResult, GraphSnapshot } from "../protocol";

  export let moduleId: string;
  export let entry: string;
  export let tag: string;
  export let label: string;
  export let snapshot: GraphSnapshot | null;
  export let disabled: boolean;
  export let executeAction: (operation: string, target: string | undefined, input: Record<string, unknown>) => Promise<ActionResult>;
  export let selectObject: (id: string) => void;

  let host: HTMLDivElement;
  let extension: (HTMLElement & {
    snapshot?: GraphSnapshot | null;
    disabled?: boolean;
    executeAction?: typeof executeAction;
    selectObject?: typeof selectObject;
  }) | undefined;
  let error = "";

  function update(): void {
    if (!extension) return;
    extension.snapshot = snapshot;
    extension.disabled = disabled;
    extension.executeAction = executeAction;
    extension.selectObject = selectObject;
  }

  $: snapshot, disabled, executeAction, selectObject, update();

  onMount(() => {
    let alive = true;
    void import(/* @vite-ignore */ `/api/module-assets/${encodeURIComponent(moduleId)}/${entry}`)
      .then(() => {
        if (!alive) return;
        extension = document.createElement(tag) as typeof extension;
        if (!extension) return;
        host.append(extension);
        update();
      })
      .catch((cause) => {
        error = cause instanceof Error ? cause.message : "模块视图加载失败";
      });
    return () => {
      alive = false;
      extension?.remove();
    };
  });
</script>

<div class="module-extension-host" bind:this={host}>
  {#if error}<div class="module-extension-error" role="alert">{label}：{error}</div>{/if}
</div>

<style>
  .module-extension-host { display: contents; }
  .module-extension-error {
    position: absolute; left: 76px; bottom: 18px; z-index: 20; max-width: 360px;
    padding: 9px 12px; border: 1px solid rgba(229, 80, 79, 0.4); border-radius: 7px;
    background: rgba(20, 27, 38, 0.94); color: #e77b79; font: 12px/1.5 system-ui, sans-serif;
  }
</style>
