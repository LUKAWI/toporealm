import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/core/index.js";
import { listenToporealmServer } from "../src/server/index.js";
import { createExplorationRuntime, createResearchRuntime } from "./fixtures/runtimes/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiedFixture(): GraphStore {
  const base = mkdtempSync(join(tmpdir(), "toporealm-browser-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  cpSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/data/research-vertical"), workspace, { recursive: true });
  cpSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/data/modules"), join(base, "modules"), { recursive: true });
  return GraphStore.fromWorkspace(workspace, "research-demo");
}

describe("real Server browser protocol smoke", () => {
  it("从 Web 根页面走到编辑、历史、动作、冲突和刷新持久化", async () => {
    const store = copiedFixture();
    const server = await listenToporealmServer(store, 0, "127.0.0.1", { runtimes: { research: createResearchRuntime(), exploration: createExplorationRuntime() } });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器没有地址");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const root = await fetch(`${base}/`);
      const html = await root.text();
      expect(root.status).toBe(200);
      expect(html).toContain("TopoRealm");
      // v2 深空玻璃外壳：设计令牌与参考实现同源（抽屉玻璃/洗刷阶梯/缓动）
      expect(html).toContain("--glass-strong");
      expect(html).toContain("--wash-2");
      expect(html).toContain("--ease-out-quint");
      expect(html).toContain("--status-failed");
      const assetPath = /src="([^"]+\.js)"/.exec(html)?.[1];
      if (!assetPath) throw new Error("Web 根页面没有脚本资源");
      expect((await fetch(`${base}${assetPath}`)).status).toBe(200);

      const initial = await fetch(`${base}/api/graph`).then((response) => response.json()) as { revision: number; objects: Array<{ id: string }> };
      expect(initial).toMatchObject({ revision: 0 });
      const added = await fetch(`${base}/api/mutations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, mutations: [{ op: "upsert_object", object: { id: "note-1", kind: "plain", label: "浏览器笔记" } }] }) }).then((response) => response.json()) as { snapshot: { revision: number } };
      expect(added.snapshot.revision).toBe(1);
      const linked = await fetch(`${base}/api/mutations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, mutations: [{ op: "upsert_relation", relation: { id: "rel-1", kind: "supports", source: "question-1", target: "note-1", direction: "directed" } }] }) }).then((response) => response.json()) as { snapshot: { revision: number } };
      expect(linked.snapshot.revision).toBe(2);
      const undone = await fetch(`${base}/api/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 2 }) }).then((response) => response.json()) as { snapshot: { revision: number; relations: unknown[] } };
      expect(undone.snapshot).toMatchObject({ revision: 3, relations: [] });
      const redone = await fetch(`${base}/api/redo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3 }) }).then((response) => response.json()) as { snapshot: { revision: number; relations: unknown[] } };
      expect(redone.snapshot).toMatchObject({ revision: 4, relations: [{ id: "rel-1" }] });

      const conflict = await fetch(`${base}/api/mutations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 3, mutations: [{ op: "upsert_object", object: { id: "stale", kind: "plain", label: "不应写入" } }] }) });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });

      // 面板数据面：基础/完整校验区分与模块清单
      const basicValidation = await fetch(`${base}/api/validate`).then((response) => response.json()) as { ok: boolean; complete: boolean };
      expect(basicValidation).toMatchObject({ ok: true, complete: false });
      const completeValidation = await fetch(`${base}/api/validate?mode=complete`).then((response) => response.json()) as { ok: boolean; complete: boolean };
      expect(completeValidation).toMatchObject({ ok: true, complete: true });
      const modules = await fetch(`${base}/api/modules`).then((response) => response.json()) as { modules: Array<{ id: string; status: string }> };
      expect(modules.modules.length).toBeGreaterThan(0);

      const action = await fetch(`${base}/api/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "research.expand-question", target: "question-1", input: { depth: 1 } }) }).then((response) => response.json()) as { kind: string; mutation?: { snapshot: { revision: number } } };
      expect(action).toMatchObject({ kind: "mutation", mutation: { snapshot: { revision: 5 } } });
      const refreshed = await fetch(`${base}/api/graph`).then((response) => response.json()) as { revision: number; objects: Array<{ id: string }> };
      expect(refreshed.revision).toBe(5);
      expect(refreshed.objects.map((object) => object.id)).toContain("question-1-claim");
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
