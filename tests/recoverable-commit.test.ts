import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RecoverableGraphPersistence, type DurableFileChange, type FaultPoint } from "../src/core/recoverable.js";

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "toporealm-recoverable-"));
  roots.push(root);
  return root;
};
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function initial(root: string): DurableFileChange[] {
  mkdirSync(join(root, "objects"), { recursive: true });
  writeFileSync(join(root, "graph.yaml"), "id: old\n", "utf8");
  writeFileSync(join(root, "objects", "a.yaml"), "id: a\nlabel: old\n", "utf8");
  writeFileSync(join(root, ".revision.json"), '{"revision":1}', "utf8");
  writeFileSync(join(root, ".history.json"), '{"commitId":"old"}', "utf8");
  writeFileSync(join(root, ".audit.json"), '[{"commitId":"old"}]', "utf8");
  return [
    { path: "graph.yaml", role: "fact", before: "id: old\n", after: "id: new\n" },
    { path: "objects/a.yaml", role: "fact", before: "id: a\nlabel: old\n", after: "id: a\nlabel: new\n" },
    { path: ".revision.json", role: "fact", before: '{"revision":1}', after: '{"revision":2,"commitId":"c2"}' },
    { path: ".history.json", role: "history", before: '{"commitId":"old"}', after: '{"commitId":"c2"}' },
    { path: ".audit.json", role: "audit", before: '[{"commitId":"old"}]', after: '[{"commitId":"old"},{"commitId":"c2"}]' },
  ];
}

describe("RecoverableGraphPersistence", () => {
  it("用图目录锁拒绝另一个本地进程", async () => {
    const root = makeRoot();
    const lockPath = join(root, ".toporealm.lock");
    const child = spawn(process.execPath, ["-e", `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(lockPath)},JSON.stringify({pid:process.pid}));console.log('ready');setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });
    try {
      expect(() => new RecoverableGraphPersistence(root).runExclusive(() => undefined)).toThrowError(expect.objectContaining({ code: "GRAPH_LOCKED" }));
    } finally {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    expect(() => new RecoverableGraphPersistence(root).runExclusive(() => undefined)).not.toThrow();
  });

  it("重复多进程竞争时至多一个提交成功，失败者不污染四类持久状态", async () => {
    const moduleUrl = pathToFileURL(resolve("dist/core/recoverable.js")).href;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const root = makeRoot();
      const files = initial(root);
      const source = `const {RecoverableGraphPersistence}=await import(${JSON.stringify(moduleUrl)});const files=${JSON.stringify(files)};try{new RecoverableGraphPersistence(${JSON.stringify(root)}).commit({commitId:"c2",baseRevision:1,nextRevision:2,files});process.stdout.write("ok")}catch(error){process.stdout.write(String(error.code??error.message))}`;
      const run = () => new Promise<string>((resolveOutput, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolveOutput(output) : reject(new Error(`child exit ${code}`)));
      });
      const results = await Promise.all([run(), run()]);
      expect(results.filter((item) => item === "ok")).toHaveLength(1);
      expect(results.some((item) => item === "GRAPH_LOCKED" || item === "EXTERNAL_EDIT_RACE")).toBe(true);
      for (const file of files) expect(readFileSync(join(root, file.path), "utf8")).toBe(file.after);
    }
  });

  it("提交 facts、revision、history、audit 的同一 commit", () => {
    const root = makeRoot();
    const files = initial(root);
    new RecoverableGraphPersistence(root).commit({ commitId: "c2", baseRevision: 1, nextRevision: 2, files });
    expect(readFileSync(join(root, "objects/a.yaml"), "utf8")).toContain("new");
    expect(readFileSync(join(root, ".revision.json"), "utf8")).toContain('"commitId":"c2"');
    expect(readFileSync(join(root, ".history.json"), "utf8")).toContain("c2");
    expect(readFileSync(join(root, ".audit.json"), "utf8")).toContain("c2");
  });

  for (const [fault, expectNew] of [
    ["lock_before_journal", false],
    ["staging_incomplete", false],
    ["prepared", false],
    ["applying_before_first", false],
    ["applying:1", false],
    ["facts_complete_marker_gap", true],
    ["history:1", true],
    ["audit:1", true],
    ["committed", true],
    ["cleanup_partial", true],
  ] as const satisfies readonly (readonly [FaultPoint, boolean])[]) {
    it(`在 ${fault} 中断后只恢复完整旧版或完整新版`, () => {
      const root = makeRoot();
      const files = initial(root);
      expect(() => new RecoverableGraphPersistence(root, { faultAt: fault }).commit({ commitId: "c2", baseRevision: 1, nextRevision: 2, files })).toThrowError(/FAULT_INJECTED/);
      new RecoverableGraphPersistence(root).recover();
      const durable = files.filter((file) => file.role !== "audit");
      const values = durable.map((file) => readFileSync(join(root, file.path), "utf8"));
      const allOld = values.every((value, index) => value === durable[index]!.before);
      const allNew = values.every((value, index) => value === durable[index]!.after);
      expect(allOld || allNew).toBe(true);
      expect(allNew).toBe(expectNew);
      const audit = JSON.parse(readFileSync(join(root, ".audit.json"), "utf8")) as Array<{ commitId: string; recoveryStatus?: string }>;
      const recovered = audit.find((item) => item.commitId === "c2");
      if (fault === "lock_before_journal" || fault === "staging_incomplete") expect(recovered).toBeUndefined();
      else if (!expectNew) expect(recovered).toMatchObject({ recoveryStatus: "rolled-back" });
      else if (fault === "committed" || fault === "cleanup_partial") expect(recovered).toMatchObject({ recoveryStatus: "committed" });
      else expect(recovered).toMatchObject({ recoveryStatus: "recovered-complete" });
      const revision = JSON.parse(readFileSync(join(root, ".revision.json"), "utf8")) as { revision: number };
      const currentGraph = readFileSync(join(root, "graph.yaml"), "utf8");
      expect(() => new RecoverableGraphPersistence(root).commit({
        commitId: `after-${fault}`,
        baseRevision: revision.revision,
        nextRevision: revision.revision + 1,
        files: [
          { path: "graph.yaml", role: "fact", before: currentGraph, after: `${currentGraph.trim()}-continued\n` },
          { path: ".revision.json", role: "fact", before: JSON.stringify(revision), after: JSON.stringify({ revision: revision.revision + 1 }) },
        ],
      })).not.toThrow();
    });
  }
});
