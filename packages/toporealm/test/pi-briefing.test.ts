import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import piBriefing from "../extensions/pi-briefing.js";

// ---------- 1.2.0 G3-8：pi Windows 入场摘要 ----------
//
// 修复前：win32 上 npm 全局 bin 是 .cmd shim，execFile 不经 shell 必 ENOENT →
// 静默 catch → 入场摘要恒缺席。修复后 win32 走 shell 跑整串命令。
// 本测试用 PATH 前置的 fake CLI 验证 session_start 摘要链路真实可执行
// （失败静默的 best-effort 语义不变）。

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function makePi(): {
  handlers: Map<string, Handler>;
  pi: { on: (event: string, handler: Handler) => void };
} {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler);
      },
    },
  };
}

/** PATH 前置 fake CLI（平台对应形态），返回恢复函数 */
async function withFakeCli(
  binDir: string,
  body: string,
  fn: () => Promise<void>,
): Promise<void> {
  const isWin = process.platform === "win32";
  await fsp.mkdir(binDir, { recursive: true });
  const cliPath = path.join(binDir, isWin ? "toporealm.cmd" : "toporealm");
  await fsp.writeFile(cliPath, body, "utf8");
  if (!isWin) await fsp.chmod(cliPath, 0o755);
  const prevPath = process.env["PATH"];
  process.env["PATH"] = `${binDir}${path.delimiter}${prevPath ?? ""}`;
  try {
    await fn();
  } finally {
    if (prevPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = prevPath;
  }
}

const FAKE_STATUS_WIN = "@echo off\r\necho g1 @ rev 7\r\necho modules 0\r\n";
const FAKE_STATUS_POSIX = "#!/bin/sh\necho 'g1 @ rev 7'\necho 'modules 0'\n";

describe("G3-8 pi-briefing session_start 入场摘要", () => {
  it
    .skipIf(process.platform === "win32")(
      "非 win32：execFile 直跑 PATH 上的原生 CLI → ui.notify 收到摘要",
      async () => {
        const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-pi-"));
        const { pi, handlers } = makePi();
        piBriefing(pi);
        const handler = handlers.get("session_start");
        expect(handler).toBeDefined();
        const notes: string[] = [];
        const ctx = { ui: { notify: (m: string) => void notes.push(m) } };
        await withFakeCli(binDir, FAKE_STATUS_POSIX, async () => {
          await handler?.({}, ctx);
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("TopoRealm: ");
        expect(notes[0]).toContain("g1 @ rev 7");
        await fsp.rm(binDir, { recursive: true, force: true }).catch(() => {});
      },
    );

  it
    .skipIf(process.platform !== "win32")(
      "win32：shell 化执行 PATH 上的 toporealm.cmd shim → ui.notify 收到摘要（修复前 ENOENT 恒缺席）",
      async () => {
        const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-pi-"));
        const { pi, handlers } = makePi();
        piBriefing(pi);
        const handler = handlers.get("session_start");
        expect(handler).toBeDefined();
        const notes: string[] = [];
        const ctx = { ui: { notify: (m: string) => void notes.push(m) } };
        await withFakeCli(binDir, FAKE_STATUS_WIN, async () => {
          await handler?.({}, ctx);
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toContain("TopoRealm: ");
        expect(notes[0]).toContain("g1 @ rev 7");
        await fsp.rm(binDir, { recursive: true, force: true }).catch(() => {});
      },
    );

  it("CLI 不在 PATH → 静默缺席（不抛错、不通知；best-effort 语义不变）", async () => {
    const binDir = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-g3-pi-empty-"));
    const { pi, handlers } = makePi();
    piBriefing(pi);
    const handler = handlers.get("session_start");
    const notes: string[] = [];
    const ctx = { ui: { notify: (m: string) => void notes.push(m) } };
    // PATH 只含一个空目录：找不到 toporealm → 失败被 catch → 摘要缺席
    const prevPath = process.env["PATH"];
    process.env["PATH"] = binDir;
    try {
      await handler?.({}, ctx);
    } finally {
      if (prevPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = prevPath;
    }
    expect(notes).toHaveLength(0);
    await fsp.rm(binDir, { recursive: true, force: true }).catch(() => {});
  });
});
