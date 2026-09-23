#!/usr/bin/env node
// 聚合包 bin 壳：按包名解析真实入口（不依赖 hoisting 布局），转交 @lukawi/toporealm-cli 的 toporealm。
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const req = createRequire(import.meta.url);
const pkgPath = req.resolve("@lukawi/toporealm-cli/package.json");
const pkg = req(pkgPath);
const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["toporealm"] ?? "bin/toporealm.mjs";
await import(pathToFileURL(path.join(path.dirname(pkgPath), binRel)).href);
