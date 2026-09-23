import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryClient } from "@lukawi/toporealm-client";
import { DaemonCore } from "@lukawi/toporealm-daemon-core";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { migrateGraph } from "../src/migrate.js";

// ---------- M4 迁移 CLI（blueprint §6 / §1.6 D23③ / §9 M4「旧 fixture 图迁移报告零意外」） ----------
// 输入 = 合成 0.x fixture 图（graph.yaml v1 + objects/ + relations/ + .revision.json）；
// 断言 payload 机械合并、键冲突报告完整性、undo 游标清零、历史不迁移、--dry-run 零落盘、
// 迁移后的图在 daemon（MemoryClient 主缝）上可装载可读。

const legacyDir = fileURLToPath(
  new URL("../../../tests/fixtures/data/legacy-research", import.meta.url),
);

async function makeWorkspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-mig-"));
  await fsp.mkdir(path.join(root, ".toporealm"), { recursive: true });
  await DaemonCore.createGraph(root, "seed");
  // 镜像 new「即选中」：真实工作区始终有 active 指针
  await fsp.writeFile(path.join(root, ".toporealm", "active"), "seed\n", "utf8");
  return root;
}

describe("migrate：0.x → 1.0 机械映射", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) {
      await fsp.rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("payload 合并：data/capabilities/label/meta 四类来源各就各位；kind/direction/id 原样", async () => {
    const root = await makeWorkspace();
    roots.push(root);
    const report = await migrateGraph({ root, oldDir: legacyDir });
    expect(report.dryRun).toBe(false);
    expect(report.graph).toEqual({
      id: "legacy-research",
      label: "注意力机制研究（0.x 遗留）",
      revision: 7, // .revision.json 保留计数
      undoCursor: 0, // undo 游标清零
    });
    expect(report.objects).toEqual({ migrated: 3, skipped: 0 });
    expect(report.relations).toEqual({ migrated: 2, skipped: 0 });
    expect(report.errors).toEqual([]);

    // q-001：data 浅合并 + capabilities 无冲突原键 + label→title + meta 嵌套
    const q1 = parseYaml(await fsp.readFile(path.join(report.target, "objects", "q-001.yaml"), "utf8"));
    expect(q1).toEqual({
      id: "q-001",
      kind: "research.question",
      payload: {
        scope: "transformer",
        status: "open",
        "exploration.unknown": { confidence: "low" },
        title: "注意力机制为什么有效？",
        meta: { created_at: "2026-09-08T10:00:00+08:00", updated_at: "2026-09-08T11:00:00+08:00" },
      },
    });
    // 关系：source/target/direction 原样；无 direction 字段时不写（1.0 缺省 directed）
    const r1 = parseYaml(await fsp.readFile(path.join(report.target, "relations", "r-001.yaml"), "utf8"));
    expect(r1).toMatchObject({
      id: "r-001",
      kind: "research.supports",
      source: "q-001",
      target: "bare",
      direction: "directed",
    });
    expect((r1 as { payload: Record<string, unknown> }).payload).toEqual({
      strength: "strong",
      title: "支持",
      meta: { created_at: "2026-09-08T10:05:00+08:00" },
    });
  });

  it("冲突报告完整性：data-vs-capabilities 更名 cap_<键>、label/meta 让位 data，全部逐条在案", async () => {
    const root = await makeWorkspace();
    roots.push(root);
    const report = await migrateGraph({ root, oldDir: legacyDir });
    const qc = parseYaml(await fsp.readFile(path.join(report.target, "objects", "q-conflict.yaml"), "utf8")) as {
      payload: Record<string, unknown>;
    };
    // data 优先：note/title/meta 三个键都是 data 的值；capabilities.note 更名 cap_note
    expect(qc.payload).toEqual({
      note: "data 优先的备注",
      title: "data 自带标题",
      meta: "data 自带 meta",
      cap_note: { weight: 0.8 },
    });
    expect(report.conflicts).toHaveLength(3);
    expect(report.conflicts).toContainEqual({
      entity: "q-conflict",
      kind: "research.question",
      type: "data-vs-capabilities",
      key: "note",
      resolution: 'data 优先；capabilities 条目更名 "cap_note" 落位',
    });
    expect(report.conflicts).toContainEqual(
      expect.objectContaining({ entity: "q-conflict", type: "label-vs-payload", key: "title" }),
    );
    expect(report.conflicts).toContainEqual(
      expect.objectContaining({ entity: "q-conflict", type: "meta-vs-payload", key: "meta" }),
    );
    // 降级清单：清单外字段丢弃 + graph 级 meta 丢弃，逐条点名
    const details = report.degradations.map((d) => d.detail);
    expect(details.some((d) => d.includes('清单外字段 "extra_out_of_contract"'))).toBe(true);
    expect(details.some((d) => d.includes("graph.yaml v1 顶层 meta"))).toBe(true);
    expect(report.degradations.find((d) => d.entity === "q-conflict" && d.detail.includes("meta 对象被放弃"))).toBeTruthy();
  });

  it("★M4 验收：旧 fixture 图迁移报告零意外，迁移后的图在 daemon 上装载/可读/undo 不可用", async () => {
    const root = await makeWorkspace();
    roots.push(root);
    const report = await migrateGraph({ root, oldDir: legacyDir });
    // 零意外：错误清单为空；悬空边只有 fixture 刻意埋的那一条，且逐条点名
    expect(report.errors).toEqual([]);
    expect(report.dangling).toEqual(["r-dangling"]);
    // 报告附模块引用的 v2 声明投影（kinds 从迁移后数据观测；version/entry 标注占位）
    expect(report.modules.map((m) => m.id)).toEqual(["research", "exploration"]);
    const research = report.modules[0] as unknown as {
      namespace: string;
      schema: number;
      declaration: string;
      placeholders: string[];
    };
    expect(research.namespace).toBe("research");
    expect(research.schema).toBe(1);
    expect(research.declaration).toContain("format: toporealm.module/v2");
    expect(research.declaration).toContain("objects:");
    expect(research.declaration).toContain("- question");
    expect(research.declaration).toContain("relations:");
    expect(research.declaration).toContain("- supports");
    expect(research.placeholders).toHaveLength(2);

    // 迁移后的图被选中（同 new）且 daemon 装载成功：rev 7、3 实体 + 2 关系、undo 不可用（历史不迁移）
    expect(await fsp.readFile(path.join(root, ".toporealm", "active"), "utf8")).toBe("legacy-research\n");
    const client = new MemoryClient({ watch: false });
    const s = await client.connect({ root, graph: "legacy-research" });
    try {
      const st = await s.status();
      expect(st.graphId).toBe("legacy-research");
      expect(st.revision).toBe(7);
      expect(st.canUndo).toBe(false);
      expect(st.canRedo).toBe(false);
      expect(st.counts["research.question"]).toBe(2);
      expect(st.counts["research.claim"]).toBe(1);
      expect(st.counts["research.supports"]).toBe(2);
      const got = await s.read({ ids: ["q-001"] });
      expect(got.entities[0]?.payload?.title).toBe("注意力机制为什么有效？");
      // 提交日志从空开始（历史不迁移），新提交正常追加
      expect(await s.log()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("--dry-run：报告与实跑一致，但零落盘、不选中", async () => {
    const root = await makeWorkspace();
    roots.push(root);
    const report = await migrateGraph({ root, oldDir: legacyDir, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.graph.revision).toBe(7);
    expect(report.objects.migrated).toBe(3);
    expect(report.conflicts).toHaveLength(3);
    // 零落盘：无图目录、无 .log、active 未动
    await expect(fsp.access(path.join(root, "graphs", "legacy-research"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fsp.readFile(path.join(root, ".toporealm", "active"), "utf8")).toBe("seed\n");
    // 实跑紧随其后照常工作（dry-run 无副作用）
    const report2 = await migrateGraph({ root, oldDir: legacyDir });
    expect(report2.dryRun).toBe(false);
    expect(report2.objects).toEqual(report.objects);
  });

  it("目标已存在合法 v2 图 → ID_EXISTS 拒绝覆盖；输入不是 v1 → 如实拒绝", async () => {
    const root = await makeWorkspace();
    roots.push(root);
    await migrateGraph({ root, oldDir: legacyDir });
    await expect(migrateGraph({ root, oldDir: legacyDir })).rejects.toMatchObject({ code: "ID_EXISTS" });

    const bad = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-notlegacy-"));
    roots.push(bad);
    await fsp.writeFile(path.join(bad, "graph.yaml"), "format: toporealm.graph/v2\nid: x\nrevision: 1\nundoCursor: 0\nmodules: []\n", "utf8");
    await expect(migrateGraph({ root, oldDir: bad })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("坏实体逐条入错误清单：缺 kind、文件名≠id；其余实体照迁", async () => {
    const root = await makeWorkspace();
    roots.push(root);
    const broken = await fsp.mkdtemp(path.join(os.tmpdir(), "toporealm-broken-"));
    roots.push(broken);
    await fsp.writeFile(
      path.join(broken, "graph.yaml"),
      "format: toporealm.graph/v1\nid: broken\nsources: {objects: objects/*.yaml, relations: relations/*.yaml}\n",
      "utf8",
    );
    await fsp.writeFile(path.join(broken, ".revision.json"), JSON.stringify({ revision: 2 }), "utf8");
    await fsp.mkdir(path.join(broken, "objects"), { recursive: true });
    await fsp.mkdir(path.join(broken, "relations"), { recursive: true });
    await fsp.writeFile(path.join(broken, "objects", "ok.yaml"), "id: ok\nkind: pub.thing\nlabel: OK\n", "utf8");
    await fsp.writeFile(path.join(broken, "objects", "nokind.yaml"), "id: nokind\nlabel: 缺 kind\n", "utf8");
    await fsp.writeFile(path.join(broken, "objects", "mismatch.yaml"), "id: other\nkind: pub.thing\n", "utf8");
    const report = await migrateGraph({ root, oldDir: broken });
    expect(report.objects.migrated).toBe(1);
    expect(report.objects.skipped).toBe(2);
    // 错误清单按实体 id 点名（mismatch.yaml 里的实体 id 是 other），file 字段记来源文件
    expect(report.errors.map((e) => e.entity).sort()).toEqual(["nokind", "other"]);
    expect(report.errors.find((e) => e.entity === "other")?.file).toBe("mismatch.yaml");
    expect(report.graph.revision).toBe(2);
  });
});

function parseYaml(text: string): unknown {
  return parse(text);
}
