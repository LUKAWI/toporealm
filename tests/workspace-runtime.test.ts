import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/core/store.js";
import { createWorkspaceRuntime } from "../src/runtime/workspace.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("Workspace Runtime 组合根", () => {
  it("一次创建返回同一 graph revision 的 registry 与 ManagedGraph", async () => {
    const root = mkdtempSync(join(tmpdir(), "toporealm-runtime-"));
    roots.push(root);
    const store = GraphStore.fromWorkspace(root, "demo");
    store.initialize({
      format: "toporealm.graph/v1", id: "demo",
      modules: [{ id: "missing", namespace: "missing", schema: 1 }],
      sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
    });
    const runtime = await createWorkspaceRuntime({ workspaceRoot: root, graphId: "demo" });
    const read = runtime.graph.read();
    expect(runtime).toMatchObject({ workspaceRoot: root, graphId: "demo" });
    expect(runtime.registry.registryRevision).toBe(read.revision);
    expect(runtime.registry.modules).toEqual([expect.objectContaining({ id: "missing", status: "unavailable" })]);
    expect(read).toMatchObject({ complete: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: "MODULE_UNAVAILABLE" })]) });
  });
});
