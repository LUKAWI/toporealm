import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ---------- 测试隔离辅助（1.2.0 G5：测试隔离债根治） ----------
//
// 开发机 ~/.toporealm/modules（全局池，目录即注册）会泄漏进一切未注入 globalRoot 的
// ModuleHost.load（host.ts：opts.globalRoot ?? globalPaths().root）与 daemon 拉起路径，
// 与测试 fixture（workflow-mini，ns=wf）命名空间冲突；CI 无全局池所以绿。
// 本 helper 把测试进程的 TOPOREALM_HOME 指向一次性空目录实现环境隔离：
// memory/WS 走进程内读 process.env，IPC/CLI 经 spawn 继承父 env 传给 daemon 孙进程。
// afterAll 必须 restore——vitest 文件全局串行但 worker 跨文件复用，不恢复会污染后续文件。

export interface IsolatedGlobalHome {
  home: string;
  /** 恢复进入时的 TOPOREALM_HOME（afterAll 调用；幂等） */
  restore: () => void;
}

export async function isolateGlobalHome(): Promise<IsolatedGlobalHome> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-test-home-"));
  const prev = process.env["TOPOREALM_HOME"];
  process.env["TOPOREALM_HOME"] = home;
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env["TOPOREALM_HOME"];
      else process.env["TOPOREALM_HOME"] = prev;
    },
  };
}
