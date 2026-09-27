import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { MemoryClient } from "@lukawi/toporealm-client";
import type {
  DaemonClient,
  GraphSummary,
  Session,
} from "@lukawi/toporealm-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { isolateGlobalHome } from "../../../tests/test-env.js";

// ---------- 1.2.0 G3 CLI 侧：help 回显解析根（D26）+ status warnings 段（D38） ----------

// MemoryClient 装载走进程环境解析全局池——与开发机 ~/.toporealm 隔离（G5 同款）
let restoreHome: (() => void) | undefined;
beforeAll(async () => {
  restoreHome = (await isolateGlobalHome()).restore;
});
afterAll(() => {
  restoreHome?.();
});

async function tmpWorkspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-cli-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "g1");
  await fsp.writeFile(path.join(root, ".toporealm", "active"), "g1\n", "utf8");
  return root;
}

function capture(): { out: string; err: string } {
  return { out: "", err: "" };
}

describe("G3-5（D26）help 尾部回显解析根", () => {
  it("TOPOREALM_HOME 注入 → 人类输出与 --json data.paths 回显全局/项目池根实际路径", async () => {
    const root = await tmpWorkspace();
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-home-"));
    const projectPool = path.join(root, ".toporealm", "modules");
    const env = { TOPOREALM_HOME: home };
    const deps = {
      cwd: root,
      env,
      clientFactory: () => new MemoryClient(),
      out: (s: string) => void s,
      err: (s: string) => void s,
    };

    // 人类输出：静态表占位说明 + 两行动态回显
    const h = capture();
    const code = await run(["help"], {
      ...deps,
      out: (s: string) => (h.out += s),
      err: (s: string) => (h.err += s),
    });
    expect(code).toBe(0);
    expect(h.out).toContain("解析路径");
    expect(h.out).toContain(`全局池根 ${home}`);
    expect(h.out).toContain(`项目池根 ${projectPool}`);

    // --json：信封 data.paths 透传（加法）
    const j = capture();
    const code2 = await run(["--json", "help"], {
      ...deps,
      out: (s: string) => (j.out += s),
      err: (s: string) => (j.err += s),
    });
    expect(code2).toBe(0);
    const envelope = JSON.parse(j.out) as {
      ok: boolean;
      data: { verbs: string[]; paths: { globalRoot: string; projectPool: string } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.paths.globalRoot).toBe(home);
    expect(envelope.data.paths.projectPool).toBe(projectPool);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
  });
});

describe("G3-4（D38）status warnings 上浮", () => {
  const warnedSummary = (warnings: string[]): GraphSummary => ({
    graphId: "g1",
    revision: 3,
    counts: { task: 1 },
    modules: [],
    canUndo: true,
    canRedo: false,
    ...(warnings.length > 0 ? { warnings } : {}),
  });

  const stubClient = (summary: GraphSummary): DaemonClient =>
    ({
      connect: async () =>
        ({
          graphId: summary.graphId,
          instanceId: "stub",
          status: async () => summary,
          close: async () => {},
        }) as unknown as Session,
    }) as unknown as DaemonClient;

  it("人类输出有才显示 warnings 段；--json 信封自然透传", async () => {
    const root = await tmpWorkspace();
    // 有 warning：出现 warnings 段与内容
    const withWarnings = stubClient(
      warnedSummary(["after-commit 排队提交被拒绝：演示"]),
    );
    const h = capture();
    await run(["status"], {
      cwd: root,
      env: {},
      clientFactory: () => withWarnings,
      out: (s: string) => (h.out += s),
      err: (s: string) => (h.err += s),
    });
    expect(h.out).toContain("warnings:");
    expect(h.out).toContain("排队提交被拒绝");

    // --json：信封 data 即 GraphSummary，warnings 自然透传
    const j = capture();
    await run(["--json", "status"], {
      cwd: root,
      env: {},
      clientFactory: () => withWarnings,
      out: (s: string) => (j.out += s),
      err: (s: string) => (j.err += s),
    });
    const envelope = JSON.parse(j.out) as { ok: boolean; data: GraphSummary };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.warnings).toEqual([
      "after-commit 排队提交被拒绝：演示",
    ]);

    // 无 warning：不出现 warnings 段
    const quiet = stubClient(warnedSummary([]));
    const q = capture();
    await run(["status"], {
      cwd: root,
      env: {},
      clientFactory: () => quiet,
      out: (s: string) => (q.out += s),
      err: (s: string) => (q.err += s),
    });
    expect(q.out).not.toContain("warnings:");
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });
});
