// D34：@lukawi/toporealm-web 发布面前置——构建 web-ui 并把产物复制进包内 dist。
// 发布面事实：web 包 files 含 dist，但 1.1.2 及以前从未在发布时构建，tarball 无产物
// → 全局安装 serve 白屏。本脚本挂 prepack（npm publish / npm pack 都会触发）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webUiDir = path.join(repo, "web-ui");
const dest = path.join(repo, "packages", "web", "dist");

const build = spawnSync('npm run build', {
  cwd: webUiDir,
  stdio: "inherit",
  shell: true, // Windows 上 npm 是 npm.cmd；整串命令经 shell，避免 args+shell 的注入告警
});
if (build.error ?? build.status !== 0) {
  console.error("pack-web-dist: web-ui build 失败");
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(path.join(webUiDir, "dist"), dest, { recursive: true });
const entries = fs.readdirSync(dest);
if (!entries.includes("index.html")) {
  console.error("pack-web-dist: 产物缺 index.html——vite 构建异常");
  process.exit(1);
}
console.log(`pack-web-dist: web-ui/dist -> packages/web/dist (${entries.length} entries)`);
