import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 这是协议合同 fixture，不是存储实现：不导入 Core、不创建临时图，也不写文件。
 * 生产实现必须实现与此处冻结的阶段、恢复选择、历史边界和审计形状等价的行为。
 */

type RecoveryDecision = "rollback" | "finalize" | "manual-required";

interface ProtocolPhase {
  id: string;
  next: string;
  recovery: RecoveryDecision;
  idempotent: boolean;
}

const PROTOCOL_PHASES: readonly ProtocolPhase[] = [
  { id: "prepared", next: "applying", recovery: "rollback", idempotent: true },
  { id: "applying", next: "facts-applied", recovery: "rollback", idempotent: true },
  { id: "facts-applied", next: "history-applied", recovery: "finalize", idempotent: true },
  { id: "history-applied", next: "audit-applied", recovery: "finalize", idempotent: true },
  { id: "audit-applied", next: "committed", recovery: "finalize", idempotent: true },
  { id: "committed", next: "cleanup", recovery: "finalize", idempotent: true },
];

const RECOVERY_CASES: ReadonlyArray<{ pointId: string; decision: RecoveryDecision }> = [
  { pointId: "lock_before_journal", decision: "rollback" },
  { pointId: "staging_incomplete", decision: "rollback" },
  { pointId: "journal_prepared", decision: "rollback" },
  { pointId: "applying_before_first", decision: "rollback" },
  { pointId: "applying_partial", decision: "rollback" },
  { pointId: "facts_complete_marker_gap", decision: "finalize" },
  { pointId: "history_partial", decision: "finalize" },
  { pointId: "audit_partial", decision: "finalize" },
  { pointId: "commit_marker_cleanup", decision: "finalize" },
  { pointId: "cleanup_partial", decision: "finalize" },
  { pointId: "external_during_apply", decision: "manual-required" },
];

const AUDIT_KEYS = [
  "commitId",
  "source",
  "fromRevision",
  "toRevision",
  "timestamp",
  "label",
  "checksumSummary",
  "recoveryStatus",
] as const;

const AUDIT_CHECKSUM_KEYS = ["algorithm", "before", "after", "fileCount"] as const;
const AUDIT_SOURCES = ["core", "web", "cli", "mcp", "module", "external", "recovery"] as const;
const RECOVERY_STATUSES = ["committed", "recovered-complete", "rolled-back", "absorbed"] as const;

const AUDIT_RECORD = {
  commitId: "c_fixture_0001",
  source: "external",
  fromRevision: 7,
  toRevision: 8,
  timestamp: "2026-09-14T12:00:02.000Z",
  label: "吸收外部编辑",
  checksumSummary: {
    algorithm: "digest:v1",
    before: "digest:v1:old",
    after: "digest:v1:new",
    fileCount: 4,
  },
  recoveryStatus: "absorbed",
} as const;

const EXTERNAL_NOTICE_KEYS = [
  "code",
  "fromRevision",
  "toRevision",
  "segmentId",
  "redoCleared",
  "auditPreserved",
  "preserved",
  "complete",
  "missingModules",
] as const;

const EXTERNAL_NOTICE = {
  code: "EXTERNAL_EDIT_ABSORBED",
  fromRevision: 7,
  toRevision: 8,
  segmentId: "seg_fixture_0002",
  redoCleared: true,
  auditPreserved: true,
  preserved: true,
  complete: false,
  missingModules: ["workflow"],
} as const;

const HISTORY_RULES = {
  externalAbsorption: {
    sealsPreviousSegment: true,
    newBaselineCursor: 0,
    createsUndoEntry: false,
    redoCleared: true,
    undoCrossesSegment: false,
    redoCrossesSegment: false,
  },
  undo: { requiresCursorGreaterThanZero: true, appendsEntry: false, incrementsRevision: true },
  redo: { requiresCursorBeforeEntryCount: true, appendsEntry: false, incrementsRevision: true },
  editAfterUndo: { truncatesRedoEntries: true, redoAvailableAfterCommit: false },
} as const;

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "../docs/architecture/recoverable-commit-protocol.md");

describe("可恢复提交协议合同", () => {
  it("覆盖完整的 journal 阶段链，并为每一阶段冻结幂等恢复动作", () => {
    const expectedIds = ["prepared", "applying", "facts-applied", "history-applied", "audit-applied", "committed"];
    expect(PROTOCOL_PHASES.map((phase) => phase.id)).toEqual(expectedIds);
    expect(new Set(PROTOCOL_PHASES.map((phase) => phase.id)).size).toBe(PROTOCOL_PHASES.length);
    expect(PROTOCOL_PHASES.map((phase) => phase.next)).toEqual([
      "applying",
      "facts-applied",
      "history-applied",
      "audit-applied",
      "committed",
      "cleanup",
    ]);
    expect(PROTOCOL_PHASES.every((phase) => phase.idempotent)).toBe(true);
    expect(PROTOCOL_PHASES.filter((phase) => phase.recovery === "rollback").map((phase) => phase.id)).toEqual([
      "prepared",
      "applying",
    ]);
    expect(PROTOCOL_PHASES.filter((phase) => phase.recovery === "finalize").length).toBe(4);
  });

  it("覆盖每个内部崩溃中断点，并把越界外部写入单独标为人工恢复", () => {
    const expectedIds = [
      "lock_before_journal",
      "staging_incomplete",
      "journal_prepared",
      "applying_before_first",
      "applying_partial",
      "facts_complete_marker_gap",
      "history_partial",
      "audit_partial",
      "commit_marker_cleanup",
      "cleanup_partial",
      "external_during_apply",
    ];
    expect(RECOVERY_CASES.map((item) => item.pointId)).toEqual(expectedIds);
    expect(new Set(RECOVERY_CASES.map((item) => item.pointId)).size).toBe(RECOVERY_CASES.length);
    expect(RECOVERY_CASES.filter((item) => item.pointId !== "external_during_apply").every((item) => item.decision === "rollback" || item.decision === "finalize")).toBe(true);
    expect(RECOVERY_CASES.find((item) => item.pointId === "external_during_apply")?.decision).toBe("manual-required");
  });

  it("冻结最小 audit 键集合、摘要键集合和恢复状态", () => {
    expect(Object.keys(AUDIT_RECORD).sort()).toEqual([...AUDIT_KEYS].sort());
    expect(Object.keys(AUDIT_RECORD.checksumSummary).sort()).toEqual([...AUDIT_CHECKSUM_KEYS].sort());
    expect(AUDIT_SOURCES).toContain(AUDIT_RECORD.source);
    expect(RECOVERY_STATUSES).toContain(AUDIT_RECORD.recoveryStatus);
    expect(AUDIT_RECORD.fromRevision).toBeGreaterThanOrEqual(0);
    expect(AUDIT_RECORD.toRevision).toBe(AUDIT_RECORD.fromRevision + 1);
    expect(AUDIT_RECORD.checksumSummary.algorithm).toBe("digest:v1");

    const serialized = JSON.stringify(AUDIT_RECORD);
    for (const forbidden of ["objects", "relations", "data", "capabilities", "moduleState"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("冻结外部吸收 notice 的 revision、segment、保留和 redo 语义", () => {
    expect(Object.keys(EXTERNAL_NOTICE).sort()).toEqual([...EXTERNAL_NOTICE_KEYS].sort());
    expect(EXTERNAL_NOTICE.code).toBe("EXTERNAL_EDIT_ABSORBED");
    expect(EXTERNAL_NOTICE.toRevision).toBe(EXTERNAL_NOTICE.fromRevision + 1);
    expect(EXTERNAL_NOTICE.segmentId).toMatch(/^seg_/);
    expect(EXTERNAL_NOTICE.redoCleared).toBe(true);
    expect(EXTERNAL_NOTICE.auditPreserved).toBe(true);
    expect(EXTERNAL_NOTICE.preserved).toBe(true);
    expect(Array.isArray(EXTERNAL_NOTICE.missingModules)).toBe(true);
  });

  it("冻结 history segment 的边界，禁止跨外部 baseline 撤销或重做", () => {
    expect(HISTORY_RULES.externalAbsorption).toEqual({
      sealsPreviousSegment: true,
      newBaselineCursor: 0,
      createsUndoEntry: false,
      redoCleared: true,
      undoCrossesSegment: false,
      redoCrossesSegment: false,
    });
    expect(HISTORY_RULES.undo.appendsEntry).toBe(false);
    expect(HISTORY_RULES.redo.appendsEntry).toBe(false);
    expect(HISTORY_RULES.undo.incrementsRevision).toBe(true);
    expect(HISTORY_RULES.redo.incrementsRevision).toBe(true);
    expect(HISTORY_RULES.editAfterUndo.truncatesRedoEntries).toBe(true);
    expect(HISTORY_RULES.editAfterUndo.redoAvailableAfterCommit).toBe(false);
  });

  it("说明书包含合同 fixture 的全部阶段、中断点和最小字段", () => {
    const specification = readFileSync(SPEC_PATH, "utf8");
    for (const heading of ["## 3. 同机多进程锁", "## 4. 提交状态机", "## 5. 中断点覆盖矩阵", "## 6. 外部 YAML 编辑吸收", "## 7. History segment 与 undo/redo 边界", "## 8. 最小 audit 协议"]) {
      expect(specification).toContain(heading);
    }
    for (const phase of PROTOCOL_PHASES) expect(specification).toContain(`| \`${phase.id}\``);
    for (const item of RECOVERY_CASES) {
      if (item.pointId === "external_during_apply") {
        expect(specification).toContain(`\`${item.pointId}\``);
      } else {
        expect(specification).toContain(`| \`${item.pointId}\``);
      }
    }
    for (const key of AUDIT_KEYS) expect(specification).toContain(`\`${key}\``);
    for (const key of EXTERNAL_NOTICE_KEYS) expect(specification).toContain(`\`${key}\``);
  });
});
