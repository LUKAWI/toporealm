import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// ---------- e2e：真实 bin（node bin/toporealm.mjs）+ IPC daemon 自动拉起 ----------
// 验收路径 = blueprint §9 M1「CLI 全流程走通」：新建图→加对象→改→undo→redo→log 一条龙

const bin = fileURLToPath(new URL("../bin/toporealm.mjs", import.meta.url));

interface CliResult {
  code: number;
  out: string;
  err: string;
}

function cli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [bin, ...args], {
      cwd,
      windowsHide: true,
      env: process.env,
    });
    let out = "";
    let err = "";
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.once("error", reject);
    c.once("exit", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

it(
  "CLI 全流程一条龙（真实 bin，daemon 自动拉起/复用）",
  async () => {
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-e2e-"));
    const steps: [string[], number][] = [
      [["--json", "creategraph", "demo"], 0],
      [
        ["--json", "add", "wf.task", "--id", "t-1", "--payload", JSON.stringify({ title: "写作", status: "todo" })],
        0,
      ],
      [["--json", "set", "t-1", "status=doing"], 0],
      [["--json", "add", "wf.task", "--id", "t-2", "--payload", JSON.stringify({ title: "评审" })], 0],
      [["--json", "link", "t-1", "t-2", "--kind", "wf.related"], 0],
      [["--json", "find", "status=doing"], 0],
      [["--json", "read", "t-1"], 0],
      [["--json", "status"], 0],
      [["--json", "undo"], 0],
      [["--json", "redo"], 0],
      [["--json", "log", "-n", "3"], 0],
      [["--json", "graphs"], 0],
      [["--json", "bogus-verb"], 2],
    ];
    for (const [args, want] of steps) {
      const r = await cli(args, ws);
      if (r.code !== want) {
        throw new Error(
          `toporealm ${args.join(" ")} → exit ${r.code}（期望 ${want}）\nstdout: ${r.out}\nstderr: ${r.err}`,
        );
      }
      if (args.includes("--json")) {
        const parsed = JSON.parse(r.code === 0 ? r.out : r.err) as { ok: boolean };
        expect(parsed.ok).toBe(want === 0);
      }
    }
    // 终态：undo+redo 抵消 → 两个任务俱在，t-1 status=doing
    const st = await cli(
      ["--json", "read", "--kind", "wf.task", "--fields", "id", "payload.status"],
      ws,
    );
    expect(st.code).toBe(0);
    const parsed = JSON.parse(st.out) as {
      data: { entities: { id: string; payload?: { status?: string } }[] };
    };
    expect(parsed.data.entities).toHaveLength(2);
    const t1 = parsed.data.entities.find((e) => e.id === "t-1");
    expect(t1?.payload?.status).toBe("doing");
  },
  90_000,
);
