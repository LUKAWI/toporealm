import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { describe, expect, it } from "vitest";
import { readModuleBindings, writeModuleBinding } from "../src/bindings.js";

// ---------- G2-8：modules.yaml 损坏 → TopoError（封闭码 + 文件路径），不再裸 YAMLParseError ----------

async function tmpRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-bindings-g28-"));
}

describe("G2-8 modules.yaml 解析错误包装", () => {
  it("YAML 语法损坏 → TopoError(INVALID_INPUT)，message 含文件路径（大声失败不变）", async () => {
    const root = await tmpRoot();
    const file = path.join(root, ".toporealm", "modules.yaml");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "example: { source: path\n  broken: [unclosed\n", "utf8");
    const err: unknown = await readModuleBindings(root).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(TopoError);
    const topo = err as TopoError;
    expect(topo.code).toBe("INVALID_INPUT"); // 封闭集内既有码
    expect(topo.message).toContain(file); // 点名文件
    expect(topo.message).not.toContain("YAMLParseError"); // 不再裸抛解析器异常名
  });

  it("不回归：合法文件 / 文件不存在（=空绑定）/ 空文件照旧", async () => {
    const root = await tmpRoot();
    // 不存在
    const missing = await readModuleBindings(root);
    expect(missing).toEqual({ bindings: {}, raw: null });
    // 空文件（parse → null → 空绑定）
    const file = path.join(root, ".toporealm", "modules.yaml");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "", "utf8");
    const empty = await readModuleBindings(root);
    expect(empty.bindings).toEqual({});
    // 合法
    await fsp.writeFile(file, "example:\n  source: path\n  path: ../m\n", "utf8");
    const ok = await readModuleBindings(root);
    expect(ok.bindings).toEqual({ example: { source: "path", path: "../m" } });
  });
});

// ---------- C3：绑定写收编（原安装器 modules-yaml.ts writeBinding 迁入，语义保持） ----------

describe("writeModuleBinding", () => {
  it("B4 原子写语义保留：写入/保留其他条目/删除键，内容完整可回读、无 .tmp 残留", async () => {
    const root = await tmpRoot();
    await writeModuleBinding(root, "a", { source: "path", path: "/x" });
    await writeModuleBinding(root, "b", { source: "workspace" });
    await writeModuleBinding(root, "a", undefined); // 删除条目
    // 内容完整（保留其他条目 + 删除生效）
    const { bindings } = await readModuleBindings(root);
    expect(bindings).toEqual({ b: { source: "workspace" } });
    // 原子写（同目录 tmp + rename）不残留临时文件；父目录由原子写惰性创建
    const names = await fsp.readdir(path.join(root, ".toporealm"));
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("C3 新语义：文件损坏时写前校验大声失败（不再静默洗掉坏条目后重写）", async () => {
    const root = await tmpRoot();
    const file = path.join(root, ".toporealm", "modules.yaml");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "example: { source: path\n  broken: [unclosed\n", "utf8");
    await expect(
      writeModuleBinding(root, "x", { source: "global" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // 失败零副作用：坏文件原样保留
    expect(await fsp.readFile(file, "utf8")).toContain("broken: [unclosed");
  });
});
