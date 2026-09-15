import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openLegacyGraph } from "../src/core/legacy.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("/core/legacy 只读兼容桥", () => {
  it("无损读取 Workflow 0.1 fixture 并明确标记不完整兼容校验", () => {
    const root = mkdtempSync(join(tmpdir(), "toporealm-legacy-"));
    roots.push(root);
    const here = dirname(fileURLToPath(import.meta.url));
    cpSync(resolve(here, "fixtures/data/workflow-slice/.toporealm/graphs/workflow-demo"), root, { recursive: true });
    const reader = openLegacyGraph(root);
    const snapshot = reader.read();
    expect(snapshot.manifest.format).toBe("toporealm.graph/v1");
    expect(snapshot.objects.find((item) => item.id === "task-a")?.data).toBeDefined();
    expect(snapshot.relations.some((item) => item.kind.startsWith("workflow."))).toBe(true);
    expect(reader.validate()).toMatchObject({ complete: false, warnings: expect.arrayContaining([expect.objectContaining({ code: "LEGACY_READ_ONLY" })]) });
  });

  it("类型面不提供写方法，运行时误调用也返回迁移诊断", () => {
    const root = mkdtempSync(join(tmpdir(), "toporealm-legacy-"));
    roots.push(root);
    const reader = openLegacyGraph(root);
    expect(() => (reader as unknown as { commit(): void }).commit()).toThrowError(expect.objectContaining({ code: "LEGACY_WRITE_UNSUPPORTED" }));
    expect(Object.keys(reader).sort()).toEqual(["read", "validate"]);
  });
});
