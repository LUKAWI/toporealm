#!/usr/bin/env node
// 开发期入口：tsx 注册后加载 TS 源（M4 打包时替换为编译产物）
import { register } from "tsx/esm/api";
register();
await import("../src/bin/toporeald.ts");
