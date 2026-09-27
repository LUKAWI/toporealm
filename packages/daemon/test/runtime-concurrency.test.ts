import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DaemonCore,
  endpointAddress,
  graphPaths,
  loadManifest,
  readLog,
  workspacePaths,
  writeActiveGraphId,
} from "@lukawi/toporealm-daemon-core";
import type { IpcRequest, IpcResponse } from "@lukawi/toporealm-protocol";
import { serveDaemon } from "../src/index.js";
import { writeEndpoint } from "../src/index.js";
import { GraphRuntime } from "../src/runtime.js";
import { createWireDispatcher } from "@lukawi/toporealm-web";
import { IpcClient } from "@lukawi/toporealm-client";
import { isolateGlobalHome } from "../../../tests/test-env.js";

// ---------- A3/A4 回归：换载门收口 + dispose 所有权归 runtime ----------
//
// A3（运行实证 E7-P2）：ensureGraph 绕过 swapPromise 直呼 doSwap + 赋值先执行后完成
// → 并发双开内核、beginOp 的 op 落在正被换载的旧 core 上（跨图劈半：两 commit 分别
// 落 g2.log 与 g1.log 且都返回 ok）。修法：startSwap 先赋值 swapPromise 再执行换载体，
// ensureGraph 同构走门，maybeSwap 等待窗口复查让位。
// A4：serveDaemon.stop() dispose 启动时捕获的旧 core 引用 → 换载后当前图内核的
// fs.watch/定时器永不清理。修法：GraphRuntime.dispose() 收口，stop 只调它。

let restoreHome: (() => void) | undefined;

beforeAll(async () => {
  // 测试隔离（1.2.0 G5）：ModuleHost.load 走 globalPaths()，防开发机全局池泄漏
  restoreHome = (await isolateGlobalHome()).restore;
});

afterAll(() => {
  restoreHome?.();
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function tmpRoot(prefix: string, graphs: string[]): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `toporealm-rtc-${prefix}-`));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  for (const g of graphs) await DaemonCore.createGraph(root, g);
  return root;
}

type Res = { id: string; ok: boolean; result?: unknown; error?: { code: string } };

function makeDispatcher(runtime: GraphRuntime, origin: "cli" | "web") {
  const responses: Res[] = [];
  const d = createWireDispatcher({ runtime, origin, onStale: () => {} }, (msg) => {
    if (!("event" in msg)) responses.push(msg as IpcResponse as Res);
  });
  return { d, responses };
}

const commitReq = (id: string, entityId: string): IpcRequest =>
  ({
    id,
    op: "commit",
    input: { changes: [{ op: "put", kind: "k", id: entityId }] },
  }) as IpcRequest;

const logIds = (log: Awaited<ReturnType<typeof readLog>>): string[] =>
  log.flatMap((e) => e.changes.map((c) => c.id ?? ""));

describe("GraphRuntime 换载门（A3）", () => {
  it("并发同图 hello：恰一次换载，旧 core dispose 恰一次", async () => {
    const root = await tmpRoot("same", ["g1", "g2"]);
    const runtime = await GraphRuntime.open(root, "g1");
    const swaps: string[] = [];
    runtime.onSwap((p) => swaps.push(p.core.graphId));
    const oldCore = runtime.current().core;
    const disposeSpy = vi.spyOn(oldCore, "dispose");
    const a = makeDispatcher(runtime, "cli");
    const b = makeDispatcher(runtime, "web");

    // 两连接并发 hello 同一目标图：修复前 ensureGraph 直呼 doSwap → 双开内核
    await Promise.all([
      a.d.handle({ id: "h1", op: "hello", root, graph: "g2" } as IpcRequest),
      b.d.handle({ id: "h2", op: "hello", root, graph: "g2" } as IpcRequest),
    ]);

    expect(swaps).toEqual(["g2"]); // 恰一次换载（无并发双开）
    expect(disposeSpy).toHaveBeenCalledTimes(1); // 旧 core dispose 恰一次
    expect(runtime.current().core.graphId).toBe("g2");
    for (const r of [...a.responses, ...b.responses]) expect(r.ok).toBe(true);

    disposeSpy.mockRestore();
    a.d.dispose();
    b.d.dispose();
    runtime.dispose();
  });

  it("并发不同图 hello：换载严格串行（swapPromise 门全程在持），被换出内核逐一 dispose 不泄漏", async () => {
    const root = await tmpRoot("diff", ["g1", "g2", "g3"]);
    const disposeSpy = vi.spyOn(DaemonCore.prototype, "dispose");
    try {
      const runtime = await GraphRuntime.open(root, "g1");
      const swaps: string[] = [];
      runtime.onSwap((p) => swaps.push(p.core.graphId));
      const a = makeDispatcher(runtime, "cli");
      const b = makeDispatcher(runtime, "web");

      await Promise.all([
        a.d.handle({ id: "h1", op: "hello", root, graph: "g2" } as IpcRequest),
        b.d.handle({ id: "h2", op: "hello", root, graph: "g3" } as IpcRequest),
      ]);

      // 串行：先到先换（g2），后到排队（g3）；不重叠、不覆写、不双开
      expect(swaps).toEqual(["g2", "g3"]);
      expect(runtime.current().core.graphId).toBe("g3");
      // 被换出的 g1、g2 内核各 dispose 恰一次；g3 在 runtime.dispose 前仍在役
      expect(disposeSpy).toHaveBeenCalledTimes(2);
      runtime.dispose();
      expect(disposeSpy).toHaveBeenCalledTimes(3);

      a.d.dispose();
      b.d.dispose();
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it("E7-P2 钉住乒乓：钉 g1 连发两笔 + 跟随连接同刻提交，每笔完整落单一图、各图日志 revision 连续", async () => {
    const root = await tmpRoot("pingpong", ["g1", "g2"]);
    // active 指向 g2：跟随连接的首个请求会触发跟随换载，与钉住提交并发
    await writeActiveGraphId(workspacePaths(root).activeFile, "g2");
    const runtime = await GraphRuntime.open(root, "g1");
    const a = makeDispatcher(runtime, "cli"); // CLI 语义：hello 显式图 → 钉 g1
    const b = makeDispatcher(runtime, "web"); // WebUI 语义：跟随 active
    await a.d.handle({ id: "ha", op: "hello", root, graph: "g1" } as IpcRequest);

    // 钉住连接两连发（wire 层 void handle 完全并发的形态）+ 跟随连接同刻提交
    await Promise.all([
      a.d.handle(commitReq("c1", "t1")),
      a.d.handle(commitReq("c2", "t2")),
      b.d.handle(commitReq("c3", "t3")),
    ]);
    for (const r of [...a.responses, ...b.responses]) {
      expect(r.ok).toBe(true);
    }

    // 每图日志 revision 从 1 连续（无同 revision 双写、无跳号——跨图劈半即破此不变量）
    const g1Log = await readLog(graphPaths(root, "g1"));
    const g2Log = await readLog(graphPaths(root, "g2"));
    for (const log of [g1Log, g2Log]) {
      expect(log.map((e) => e.revision)).toEqual(
        Array.from({ length: log.length }, (_, i) => i + 1),
      );
    }
    // 三笔提交各恰好落一图（无丢失、无重复、无跨图劈半、无落已 dispose 内核的缺账）
    expect([...logIds(g1Log), ...logIds(g2Log)].sort()).toEqual([
      "t1",
      "t2",
      "t3",
    ]);

    a.d.dispose();
    b.d.dispose();
    runtime.dispose();
  });
});

describe("daemon 生命周期（A4 dispose 收口）", () => {
  it("P2-4：换载中途 stop() → 在途换载完成后新核也被 dispose（不泄漏新内核）", async () => {
    const root = await tmpRoot("p2p4", ["g1", "g2"]);
    const disposeSpy = vi.spyOn(DaemonCore.prototype, "dispose");
    try {
      const runtime = await GraphRuntime.open(root, "g1");
      // 持一个在途 op：换载入场后停在排空等待（swapPromise 在持、新核未开）
      await runtime.beginOp();
      const swapP = runtime.ensureGraph("g2");
      // 换载中途 stop：dispose 必须先等 swapPromise 完成再释放当前核
      // （修复前同步 dispose 只释放旧核 g1，换载完成接管的新核 g2 无人释放）
      const disposeP = runtime.dispose();
      runtime.endOp(); // 放行 → 换载完成（g2 新核接管、g1 旧核被 doSwap dispose）
      await swapP;
      await disposeP;
      expect(runtime.current().core.graphId).toBe("g2");
      // 被释放内核按身份断言：g1（doSwap 换出）+ g2（dispose 收尾）各恰一次。
      // 修复前 dispose 是同步的：g1 被释放两次（dispose 一次 + doSwap 一次），
      // 新核 g2 无人释放（泄漏）——只数次数会误绿，必须核对 this 身份。
      expect(
        disposeSpy.mock.contexts.map((c) => (c as DaemonCore).graphId),
      ).toEqual(["g1", "g2"]);
    } finally {
      disposeSpy.mockRestore();
    }
  });

  it("serveDaemon 换载后 stop()：当前图内核被 dispose（watcher 清理，外部编辑不再被后台吸收）", async () => {
    const root = await tmpRoot("a4", ["g1", "g2"]);
    const daemon = await serveDaemon({ root, graph: "g1", idleMs: 0, web: false });
    try {
      // daemon 不写 endpoint（toporeald 才写）：伪造一份供 IPC 附加
      const ep = endpointAddress(root);
      await writeEndpoint(root, {
        transport: ep.transport,
        address: ep.address,
        pid: process.pid,
        instanceId: daemon.instanceId,
        graphId: daemon.graphId,
        startedAt: new Date().toISOString(),
      });

      // hello 显式图 g2 → 就地换载（g1 内核 dispose，g2 内核接管）
      const ipc = await new IpcClient().connect({ root, graph: "g2" });
      expect((await ipc.status()).graphId).toBe("g2");
      await ipc.close();

      // 修复前：stop() dispose 启动时捕获的 g1 旧引用，当前 g2 内核的 watcher 存活
      await daemon.stop();

      // 可观察缝：dispose 后 fs.watch 已关——外部对象文件不再被吸收进 .log / graph.yaml
      const p = graphPaths(root, "g2");
      await fsp.writeFile(
        path.join(p.objects, "ghost.yaml"),
        "id: ghost\nkind: ghost\npayload: {}\n",
        "utf8",
      );
      await sleep(900); // > EXTERNAL_DEBOUNCE_MS(120) + reconcile 余量
      expect(await readLog(p)).toEqual([]);
      expect((await loadManifest(p)).revision).toBe(0);
    } finally {
      await daemon.stop().catch(() => {}); // 幂等兜底
    }
  }, 20000);
});
