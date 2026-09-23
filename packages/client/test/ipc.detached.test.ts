import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import {
  DaemonCore,
  readEndpoint,
  waitForPidExit,
} from "@lukawi/toporealm-daemon-core";
import { expect, it } from "vitest";
import { IpcClient } from "../src/ipc.js";

// ---------- 守护回归：daemon 不随拉起者退出（ipc.ts spawnDaemon detached 专项） ----------
// 祖先掩盖破除：vitest（祖父）绝不直接拉 daemon；由一个**必然退出**的中间进程
// （node -e）经**真实 CLI bin** 触发拉起，中间进程与 CLI 全部退出后再断言——
// 若 daemon 未脱离拉起者，endpoint 死亡、下次触达冷启动新 daemon（instanceId 漂移）。

/** 真实 CLI bin 绝对路径（workspace 根 node_modules 里的 link 可解析） */
function cliBin(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("@lukawi/toporealm-cli/package.json") as string;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  return path.join(path.dirname(pkgPath), pkg.bin?.["toporealm"] ?? "bin/toporealm.mjs");
}

/** 中间进程脚本：spawnSync 真实 CLI（拉起 daemon）→ 透传 stdout → 自身退出 */
const MIDDLE_SCRIPT = `
const { spawnSync } = require("node:child_process");
const r = spawnSync(process.execPath, [
  process.env.DETACH_CLI, "--json", "status",
  "--root", process.env.DETACH_ROOT, "--graph", "g1",
], { encoding: "utf8", timeout: 60000, windowsHide: true });
if (r.error) throw r.error;
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);
`;

async function runRealCli(
  bin: string,
  root: string,
  args: string[],
): Promise<{ code: number; envelope: Record<string, unknown> }> {
  const r = spawnSync(process.execPath, [bin, "--json", ...args, "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  expect(r.status, `CLI ${args.join(" ")} stderr: ${r.stderr}`).toBe(0);
  return { code: r.status ?? 1, envelope: JSON.parse((r.stdout ?? "").trim()) as Record<string, unknown> };
}

it(
  "拉起者（中间进程→真实 CLI）退出后 daemon 仍常驻：endpoint 应答、instanceId 跨 CLI 调用稳定",
  async () => {
    // 独立 root：确保被测 daemon 只可能由中间进程链拉起，不受共享 root 旧 daemon 干扰
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-detach-"));
    await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
    await DaemonCore.createGraph(root, "g1");
    const bin = cliBin();
    try {
      // 1) 中间进程经真实 CLI 拉起 daemon 后整体退出（spawnSync 返回 = 已退出）
      const middle = spawnSync(process.execPath, ["-e", MIDDLE_SCRIPT], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        env: { ...process.env, DETACH_CLI: bin, DETACH_ROOT: root },
      });
      expect(middle.status, `middle stderr: ${middle.stderr}`).toBe(0);
      const first = JSON.parse((middle.stdout ?? "").trim()) as {
        ok: boolean;
        instanceId: string;
      };
      expect(first.ok).toBe(true);
      expect(first.instanceId).toBeTruthy();

      // 2) 拉起者已死 → daemon 必须仍应答，且还是同一个（instanceId 稳定）
      const s = await new IpcClient().connect({ root, graph: "g1" });
      try {
        expect(s.instanceId).toBe(first.instanceId);
        expect((await s.status()).revision).toBeGreaterThanOrEqual(0);
      } finally {
        await s.close();
      }

      // 3) 第二次独立 CLI 调用：复用常驻 daemon（而非冷启动新 daemon）
      const second = await runRealCli(bin, root, ["status", "--graph", "g1"]);
      expect(second.envelope.instanceId).toBe(first.instanceId);
    } finally {
      // 清理路径：daemon 已脱离进程树，须按 endpoint pid 显式收割
      const ep = await readEndpoint(root).catch(() => null);
      if (ep) {
        try {
          process.kill(ep.pid);
        } catch {
          /* 已退出 */
        }
        await waitForPidExit(ep.pid).catch(() => {});
      }
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  },
  60_000,
);
