import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("web-ui/dist");
const target = resolve("dist/web-assets");
if (!existsSync(source)) throw new Error(`Web 构建目录不存在：${source}`);
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

const skillsSource = resolve("integrations/src/skills");
const skillsTarget = resolve("dist/integrations/skills");
if (!existsSync(skillsSource)) throw new Error(`Skills 正本目录不存在：${skillsSource}`);
if (existsSync(skillsTarget)) rmSync(skillsTarget, { recursive: true, force: true });
cpSync(skillsSource, skillsTarget, { recursive: true });
