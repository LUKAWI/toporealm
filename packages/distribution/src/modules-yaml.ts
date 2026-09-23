import fsp from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";

// ---------- modules.yaml 绑定的安装器侧读写（blueprint §3：{ [id]: { source, path? } }） ----------
// 格式的规范解析住 module-host（readModuleBindings）；这里只做安装器需要的最小读写。
// 安装器重写文件改变内容摘要 = daemon 端模块集过期检测（§5）天然生效，客户端下次
// 触达自动拉起装载新模块集的 daemon——安装器因此不需要也不应该触碰运行中的 daemon。

export interface InstallerBinding {
  source: "workspace" | "global" | "path";
  path?: string;
}

export type InstallerBindings = Record<string, InstallerBinding>;

export async function readBindingsRaw(file: string): Promise<InstallerBindings> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const doc = parse(text) as unknown;
  if (doc === undefined || doc === null) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`modules.yaml 不是映射：${file}`);
  }
  const out: InstallerBindings = {};
  for (const [id, value] of Object.entries(doc as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const b = value as Record<string, unknown>;
    if (b.source !== "workspace" && b.source !== "global" && b.source !== "path") continue;
    out[id] = {
      source: b.source,
      ...(b.path !== undefined ? { path: String(b.path) } : {}),
    };
  }
  return out;
}

/** 写入绑定（保留其他条目；set 为 undefined = 删除该键）。 */
export async function writeBinding(
  file: string,
  id: string,
  binding: InstallerBinding | undefined,
): Promise<void> {
  const bindings = await readBindingsRaw(file);
  if (binding === undefined) delete bindings[id];
  else bindings[id] = binding;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, stringify(bindings, { lineWidth: 0 }), "utf8");
}
