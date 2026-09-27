// ---------- CLI golden 信封共享助手（批次 D：envelope / usage-g2 / distribution-verbs 三处近似实现合一） ----------
//
// blueprint §8：golden 缝 = CliDeps 注入。execGolden 每次调用建全新 deps 与输出
// 收集器——一条命令一次一命，信封断言互不串扰；断言仍由各测试文件自有 exec 薄包装
// 保持原调用形状不变。
import type { DaemonClient } from "@lukawi/toporealm-protocol";
import { run, type CliDeps } from "../src/index.js";

/** execGolden 的返回：退出码 + 双路输出原文（信封断言喂 jsonOf） */
export interface CliRunResult {
  code: number;
  out: string;
  err: string;
}

/**
 * 跑一条 CLI 命令并收集信封输出。缺省不注入 clientFactory（冷路径分发动词的
 * 形态，落回 run() 的 IpcClient 缺省）；golden 信封用例显式传 MemoryClient 工厂。
 */
export async function execGolden(
  args: string[],
  cwd: string,
  clientFactory?: () => DaemonClient,
): Promise<CliRunResult> {
  const collected = { out: "", err: "" };
  const deps: CliDeps = {
    ...(clientFactory !== undefined ? { clientFactory } : {}),
    cwd,
    env: {},
    out: (s: string) => {
      collected.out += s;
    },
    err: (s: string) => {
      collected.err += s;
    },
  };
  const code = await run(args, deps);
  return { code, out: collected.out, err: collected.err };
}

/** --json 信封解析：退出码 0 取 stdout，非 0 取 stderr（blueprint §4 信封契约） */
export function jsonOf(r: CliRunResult): Record<string, unknown> {
  return JSON.parse(r.code === 0 ? r.out : r.err) as Record<string, unknown>;
}
