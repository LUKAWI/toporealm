import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeCli,
  resolveGraphTarget,
  resolveWorkspaceRoot,
  runCli,
  runActionCli,
} from "../src/cli/index.js";
import { GraphStore } from "../src/core/index.js";
import { installModule } from "../src/distribution/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "toporealm-cli-"));
  roots.push(root);
  return root;
}

describe("TopoRealm CLI 工作区与目标图解析", () => {
  it("从子目录发现工作区，并按显式参数、环境变量、当前图、默认图的顺序解析", () => {
    const root = tempRoot();
    const nested = join(root, "packages", "demo");
    mkdirSync(nested, { recursive: true });
    runCli(["init", "default"], root);
    runCli(["init", "other"], root);

    expect(resolveWorkspaceRoot({ cwd: nested })).toBe(root);
    expect(resolveWorkspaceRoot({ cwd: tempRoot(), env: { TOPOREALM_ROOT: root } })).toBe(root);
    expect(resolveGraphTarget(root, { explicitGraph: "other", env: { TOPOREALM_GRAPH: "default" } })).toBe("other");
    expect(resolveGraphTarget(root, { env: { TOPOREALM_GRAPH: "other" } })).toBe("other");

    runCli(["switch", "other"], root);
    expect(resolveGraphTarget(root, {})).toBe("other");
    expect(() => resolveGraphTarget(root, { explicitGraph: "missing" })).toThrow(/missing/);
  });
});

describe("TopoRealm CLI 命令面", () => {
  it("用 JSON 输出贯通图初始化、切换、读写、历史与两级校验", () => {
    const root = tempRoot();
    expect(JSON.parse(runCli(["init", "demo"], root))).toMatchObject({ manifest: { id: "demo" }, revision: 0 });
    expect(JSON.parse(runCli(["list"], root))).toMatchObject({ currentId: "demo", graphs: [{ id: "demo" }] });
    const applied = JSON.parse(runCli(["--graph", "demo", "apply", JSON.stringify({
      expectedRevision: 0,
      mutations: [{ op: "upsert_object", object: { id: "note-1", kind: "note", label: "Note" } }],
    })], root));
    expect(applied.snapshot.revision).toBe(1);
    expect(JSON.parse(runCli(["status"], root))).toMatchObject({ graphId: "demo", revision: 1, history: { canUndo: true, canRedo: false } });
    expect(JSON.parse(runCli(["undo"], root)).snapshot.objects).toHaveLength(0);
    expect(JSON.parse(runCli(["redo"], root)).snapshot.objects).toHaveLength(1);
    expect(JSON.parse(runCli(["validate"], root))).toMatchObject({ ok: true, complete: false });
    expect(JSON.parse(runCli(["validate", "--complete"], root))).toMatchObject({ ok: true, complete: true });
  });

  it("公开已确认命令帮助，并为用法错误与运行错误返回稳定退出码", () => {
    const help = runCli(["help"], tempRoot());
    for (const command of ["init", "list", "switch", "status", "read", "apply", "undo", "redo", "validate", "serve", "mcp", "module add|remove|list", "action list|execute", "host sync"]) {
      expect(help).toContain(command);
    }
    expect(executeCli(["unknown"], { cwd: tempRoot() })).toMatchObject({ exitCode: 2, stdout: "" });
    const missing = tempRoot();
    expect(executeCli(["--root", missing, "read"], { cwd: missing })).toMatchObject({ exitCode: 1, stdout: "" });
  });

  it("CLI action list/execute 与 MCP 共用 ActionReference 和 Core 提交边界", async () => {
    const root = tempRoot();
    runCli(["init", "demo"], root);
    installModule(resolve("tests/fixtures/packages/example-module"), { workspaceRoot: root });
    const store = GraphStore.fromWorkspace(root, "demo");
    store.apply({ expectedRevision: 0, mutations: [{
      op: "patch_manifest",
      patch: { modules: [{ id: "example", namespace: "example", schema: 1 }] },
    }] });

    const actions = JSON.parse(await runActionCli(["action", "list"], root)) as Array<{ operation: string; registryRevision: number }>;
    expect(actions.map((item) => item.operation)).toEqual(["example.create-card"]);
    const result = JSON.parse(await runActionCli(["action", "execute", JSON.stringify({
      reference: actions[0],
      input: { id: "card-cli", label: "CLI card" },
    })], root));
    expect(result).toMatchObject({ kind: "mutation", mutation: { snapshot: { revision: 2 } } });
    expect(store.read().objects).toMatchObject([{ id: "card-cli", kind: "example.card" }]);
  });

  it("提供模块管理与三宿主同步的机器可消费入口", () => {
    const root = tempRoot();
    runCli(["init", "demo"], root);
    expect(JSON.parse(runCli(["module", "list"], root))).toEqual({ modules: [] });
    const synced = JSON.parse(runCli(["host", "sync"], root));
    expect(synced.map((item: { host: string }) => item.host)).toEqual(["codex", "claude", "pi"]);
    expect(existsSync(join(root, ".codex", ".toporealm", "generated", "codex", ".codex-plugin", "plugin.json"))).toBe(true);
  });
});
