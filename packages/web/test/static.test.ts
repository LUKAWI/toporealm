import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWebUiDist } from "../src/static.js";

// ---------- D34：web-ui 产物解析序 TOPOREALM_WEB_STATIC > 本包 dist > 工作区 web-ui ----------

let tmp: string;

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-static-res-"));
  await fsp.mkdir(path.join(tmp, "a"), { recursive: true });
  await fsp.writeFile(path.join(tmp, "a", "index.html"), "x");
});
afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("resolveWebUiDist（注入 bases，确定性）", () => {
  it("环境变量最优先（绝对化返回，即使注入的 self dist 存在）", () => {
    const r = resolveWebUiDist(
      { TOPOREALM_WEB_STATIC: path.join(tmp, "env-dist") },
      { selfDist: path.join(tmp, "a"), workspaceDist: path.join(tmp, "w") },
    );
    expect(r).toBe(path.resolve(path.join(tmp, "env-dist")));
  });

  it("本包自带 dist 存在即命中（发布面路径）", () => {
    const r = resolveWebUiDist({}, { selfDist: path.join(tmp, "a"), workspaceDist: null });
    expect(r).toBe(path.join(tmp, "a"));
  });

  it("本包无产物回落工作区注入值；工作区也没有 = null（纯 WS 模式）", () => {
    const w = path.join(tmp, "w");
    expect(
      resolveWebUiDist({}, { selfDist: path.join(tmp, "nope"), workspaceDist: w }),
    ).toBe(w);
    expect(
      resolveWebUiDist({}, { selfDist: path.join(tmp, "nope"), workspaceDist: null }),
    ).toBeNull();
  });
});
