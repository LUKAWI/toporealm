#!/usr/bin/env node
// TopoRealm plugin SessionStart hook：向会话注入模块技能索引。
// 自包含尽力而为包装（blueprint §1.11 D28 Y4④）：任何失败——CLI 不在 PATH
//（ENOENT）、非零退出、超时（10s）——一律静默 exit 0，绝不让会话启动报错；
// 仅当 CLI 成功退出（code 0）时透传其 stdout。

import { spawn } from "node:child_process";

const TIMEOUT_MS = 10_000;

function finish() {
  process.exit(0);
}

try {
  // Windows 下 npm 全局 bin 是 .cmd 垫片，无 shell 时 spawn 解析不到，须 shell:true
  // 且命令整体为单个字符串（args 数组 + shell 会触发 node DEP0190 弃用警告，
  // 污染会话启动）。命令为固定字面量，无注入面。POSIX 下不用 shell。
  const [cmd, args] =
    process.platform === "win32"
      ? ["toporealm skills index", []]
      : ["toporealm", ["skills", "index"]];
  const child = spawn(cmd, args, {
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "ignore"],
  });

  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });

  const timer = setTimeout(() => {
    child.kill();
    finish();
  }, TIMEOUT_MS);

  child.on("error", () => {
    clearTimeout(timer);
    finish();
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0 && out) {
      process.stdout.write(out);
    }
    finish();
  });
} catch {
  finish();
}
