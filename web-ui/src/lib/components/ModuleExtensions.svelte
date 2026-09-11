<script lang="ts">
  import { store } from "../store.svelte";
  import ModuleExtensionHost from "./ModuleExtensionHost.svelte";

  interface ExtensionDeclaration {
    id?: string;
    label?: string;
    entry?: string;
    tag?: string;
  }

  const extensions = $derived.by(() => Object.entries(store.moduleStatus?.ui ?? {}).flatMap(([moduleId, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const declaration = value as ExtensionDeclaration;
    if (typeof declaration.entry !== "string" || typeof declaration.tag !== "string") return [];
    return [{
      moduleId,
      id: declaration.id,
      label: declaration.label,
      entry: declaration.entry.replace(/^\.\//, ""),
      tag: declaration.tag,
    }];
  }));

  async function execute(operation: string, target: string | undefined, input: Record<string, unknown>) {
    return store.executeAction(operation, target, input, store.moduleStatus?.registryRevision);
  }
</script>

{#each extensions as extension (`${extension.moduleId}:${extension.entry}`)}
  <ModuleExtensionHost
    moduleId={extension.moduleId}
    entry={extension.entry}
    tag={extension.tag}
    label={extension.label ?? extension.moduleId}
    snapshot={store.snapshot}
    disabled={store.readOnly || store.switching || store.writing}
    executeAction={execute}
    selectObject={(id: string) => store.select({ type: "object", id })}
  />
{/each}
