import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TopoError } from "@lukawi/toporealm-protocol";
import { describe, expect, it } from "vitest";
import { readModuleBindings } from "../src/bindings.js";

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
