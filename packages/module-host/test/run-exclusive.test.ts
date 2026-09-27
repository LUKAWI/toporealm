import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonCore, graphPaths, readLog } from "@lukawi/toporealm-daemon-core";
import { ModuleHost } from "../src/index.js";
import { bindingYaml } from "../../../tests/fixtures/binding-yaml.js";

// ---------- P0-1 回归：模块命令执行期独占提交管线（core.runExclusive） ----------
//
// 缺陷（红队公共缝探针两次实测复现）：命令 handler 契约级异步（protocol
// CommandHandler 返回 Promise），handler 在 await 让渡后调 api.commit → commitSync
// ——同步提交不走尾链，落进在途异步 convert 的让渡窗口（stage 定版 revision 与
// land 生效之间隔着 persistAsync 的每个 await）→ 与 wire 并发提交双 stage 同一
// revision：.log 同号两行、land 整体覆盖丢内存更新。core.ts 原「convertSync 无让渡
// 点不受影响」是错误推理——它可以运行在别人的让渡窗口里。
//
// 修法：host.run 把 `await cmd.handler(...)` 整体包进 core.runExclusive（与 convert
// 同款尾链排队）——模块命令执行期独占管线，段内 commitSync 同步内联执行（管线
// busy 的是自己），其它连接的 wire commit/undo/redo 排队等 handler 完成。
//
// 装置：fixture 模块注册异步 handler（await 定时器让渡后 api.commit），与 N 路
// wire commit（每路多个 put，拉长 persistAsync 让渡窗口）并发发射。

/** fixture 模块（duck-mod 同款内联形态）：异步 handler 让渡后 api.commit */
const MODULE_INDEX_JS = `export default { activate(api) {
  api.command(
    { name: "slow-commit", title: "异步 handler 让渡后 api.commit（P0-1 回归装置）" },
    async (ctx) => {
      await new Promise((r) => setTimeout(r, Number(ctx.input.delay ?? 8)));
      const r = api.commit({
        changes: [{ op: "put", kind: "amod.note", id: "from-module", payload: { by: "module" } }],
        label: "amod.slow-commit",
      });
      return { message: "module @ rev " + r.revision, data: { revision: r.revision } };
    },
  );
} };`;

async function tmpWorkspaceWithModule(): Promise<{
  root: string;
  core: DaemonCore;
  host: ModuleHost;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-runx-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  const dir = path.join(root, ".toporealm", "modules", "async-mod");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "module.yaml"),
    `format: toporealm.module/v2\nid: async-mod\nnamespace: amod\nversion: "1.0.0"\nentry: ./index.js\n`,
    "utf8",
  );
  await fsp.writeFile(path.join(dir, "index.js"), MODULE_INDEX_JS, "utf8");
  await fsp.writeFile(
    path.join(root, ".toporealm", "modules.yaml"),
    bindingYaml({ "async-mod": dir }),
    "utf8",
  );
  const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
  const host = await ModuleHost.load(core, { root, globalRoot: root });
  return { root, core, host };
}

describe("P0-1 模块命令执行期独占管线（runExclusive）", () => {
  it("异步 handler 中途 api.commit 与 N 路 wire commit 并发：revision 严格唯一、.log 无同号两行、两来源变更全在内存、undo 栈完整", async () => {
    const { root, core, host } = await tmpWorkspaceWithModule();
    const N = 20; // wire commit 路数
    const PUTS = 40; // 每路 put 数：拉长 persistAsync 让渡窗口（修复前探针命中面）

    // 并发发射：模块命令（handler 8ms 让渡后 commitSync）+ N 路 wire commit
    const [runRes, ...commitResults] = await Promise.all([
      host.run("amod.slow-commit", { input: { delay: 8 } }),
      ...Array.from({ length: N }, (_, i) =>
        core.commit(
          {
            changes: Array.from({ length: PUTS }, (_, j) => ({
              op: "put",
              kind: "k",
              id: `wire-${i}-${j}`,
              payload: { i, j },
            })),
            label: `wire-${i}`,
          },
          "cli",
        ),
      ),
    ]);

    // ① revision 严格唯一（修复前双 stage → 结果集合出现重号）
    const total = N + 1;
    const moduleRevs = (runRes.commits ?? []).map((c) => c.revision);
    expect(moduleRevs).toHaveLength(1); // 命令的真实提交恰一笔
    const allRevs = [...commitResults.map((r) => r.revision), ...moduleRevs];
    expect(new Set(allRevs).size).toBe(total);
    expect([...allRevs].sort((a, b) => a - b)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );

    // ② .log 无同 revision 两行（修复前 [1..k-1, k, k, k+1..]）
    const log = await readLog(graphPaths(root, "g1"));
    expect(log.map((e) => e.revision)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );

    // ③ 两来源变更都可在内存 read 到（修复前 land 整体覆盖丢一方的更新）
    const got = core.read({});
    expect(got.revision).toBe(total);
    const ids = new Set(got.entities.map((e) => e.id));
    expect(ids.has("from-module")).toBe(true);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < PUTS; j++) {
        expect(ids.has(`wire-${i}-${j}`)).toBe(true);
      }
    }

    // ④ undo 栈完整：total 步全撤 → 实体清空、日志不增；全重做 → 实体复原
    await core.undo(total, "cli");
    expect(core.status()).toMatchObject({
      revision: 2 * total,
      canUndo: false,
      canRedo: true,
    });
    expect(core.read({}).entities).toHaveLength(0);
    expect((await readLog(graphPaths(root, "g1"))).map((e) => e.revision)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    await core.redo(total, "cli");
    expect(core.status()).toMatchObject({
      revision: 3 * total,
      canUndo: true,
      canRedo: false,
    });
    expect(core.read({}).entities).toHaveLength(N * PUTS + 1);
    core.dispose();
  }, 30000);
});
