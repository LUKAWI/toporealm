import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { daemonStderrLogPath, IpcClient } from "../src/ipc.js";

// ---------- G2-1：daemon 启动死因上抛 ----------
// 修复前：spawn stdio:"ignore" + 超时归一「等待就绪超时」——坏模块 / 坏 YAML 只剩
// 10s 超时一句，真实死因被丢。修后：stderr 落 tmpdir 见证文件，超时错误携带尾部。
// 正常启动路径不回归由 ipc.transport.test / ipc.detached.test 覆盖。

describe("G2-1 daemon 启动死因上抛", () => {
  it("机制：注入的 daemon 启动即退（stderr 死因）→ connect 超时错误携带死因", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-spawnfail-"));
    await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root, "g1");
    const fakeDaemon = path.join(root, "fake-toporeald.mjs");
    await fsp.writeFile(
      fakeDaemon,
      "process.stderr.write('FAKE-DEATH: 模块集装载炸了\\n');\nprocess.exit(1);\n",
      "utf8",
    );
    const client = new IpcClient({
      daemonCommand: { cmd: process.execPath, args: [fakeDaemon] },
      connectTimeoutMs: 3000,
    });
    await expect(client.connect({ root, graph: "g1" })).rejects.toMatchObject({
      code: "DAEMON_UNREACHABLE",
      message: expect.stringContaining("FAKE-DEATH: 模块集装载炸了"),
    });
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }, 20_000);

  it("验收实证：项目池坏模块 → 真实 toporeald 死因直达错误 message（CLI 一条命令可见）", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-brokenmod-"));
    await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root, "g1");
    // 项目池坏模块：daemon 装载大声失败（设计内），退出码 1 + stderr 死因
    const broken = path.join(root, ".toporealm", "modules", "broken");
    await fsp.mkdir(broken, { recursive: true });
    await fsp.writeFile(path.join(broken, "module.yaml"), "format: nope\n", "utf8");
    const client = new IpcClient({ connectTimeoutMs: 5000 });
    const err: unknown = await client.connect({ root, graph: "g1" }).then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ code: "DAEMON_UNREACHABLE" });
    const message = (err as Error).message;
    expect(message).toContain("toporeald 退出原因");
    // 真实死因（ModuleHost 的 v2 清单执法）而非泛化超时
    expect(message).toContain("toporealm.module/v2");
    // 见证文件可复核（观测面）
    await expect(fsp.readFile(daemonStderrLogPath(root), "utf8")).resolves.toContain(
      "toporealm.module/v2",
    );
    // 失败的 daemon 从不写 endpoint → 无残留属主
    await expect(fsp.access(path.join(root, ".toporealm"))).resolves.toBeUndefined();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }, 30_000);
});
