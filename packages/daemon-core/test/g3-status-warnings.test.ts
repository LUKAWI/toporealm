import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";

// ---------- 1.2.0 G3-4（blueprint D38）：GraphSummary.warnings 上浮 ----------
// core.status() 投影 this.warnings（此前只落 onWarning/stderr）；仅非空时携带。

async function tmpWorkspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-warn-"));
  await DaemonCore.createGraph(root, "g1");
  return root;
}

describe("G3-4（D38）status 投影 warnings", () => {
  it("公共缝构造 warning：after 排队提交被拒 → status.warnings 含之；空载时不携带字段", async () => {
    const root = await tmpWorkspace();
    const core = await DaemonCore.open({ root, graphId: "g1", watch: false });
    // 空载：加法可选字段缺省不携带
    expect(core.status().warnings).toBeUndefined();

    // 公共缝：after-commit 钩子排队一个悬空关系提交 → 排空被拒 → 记 warning（D21 既有语义）
    core.registerAfterCommitHook(() => {
      core.commitSync(
        {
          changes: [
            { op: "rel", kind: "wf.blocks", source: "ghost-a", target: "ghost-b" },
          ],
        },
        "cli",
      );
    });
    await core.commit(
      { changes: [{ op: "put", kind: "task", id: "t1", payload: {} }] },
      "cli",
    );

    const st = core.status();
    expect(st.warnings).toBeDefined();
    expect(st.warnings?.some((w) => w.includes("排队提交被拒"))).toBe(true);
    core.dispose();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });
});
