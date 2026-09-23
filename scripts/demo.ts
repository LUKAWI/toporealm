// M1 验收演示：新建图→加对象→改→关系→find→undo→redo→log 一条龙（blueprint §9）
// 用法：npm run demo
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { run } from "../packages/cli/src/index.js";

const ws = process.argv[2]
  ? path.resolve(process.argv[2])
  : await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-demo-"));

console.log(`# workspace: ${ws}\n`);

const steps: string[][] = [
  ["new", "demo", "--label", "M1 验收演示"],
  ["status"],
  ["add", "wf.task", "--id", "t-1", "--payload", JSON.stringify({ title: "写蓝图", status: "todo" })],
  ["add", "wf.task", "--id", "t-2", "--payload", JSON.stringify({ title: "评审蓝图", status: "todo" })],
  ["set", "t-1", "status=doing"],
  ["link", "t-1", "t-2", "--kind", "wf.blocks"],
  ["find", "status=doing"],
  ["read", "t-1"],
  ["status"],
  ["undo"],
  ["redo"],
  ["log", "-n", "5"],
  ["graphs"],
];

for (const args of steps) {
  console.log(`$ toporealm ${args.join(" ")}`);
  const code = await run(args, {
    cwd: ws,
    env: process.env,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  if (code !== 0) {
    console.error(`\n✗ demo failed at: toporealm ${args.join(" ")} (exit ${code})`);
    process.exit(1);
  }
  console.log("");
}

console.log("✓ M1 一条龙演示通过（全流程 OK）");
