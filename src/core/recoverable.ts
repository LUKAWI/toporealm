import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { CoreError, GraphLockError } from "./errors.js";

export type DurableFileRole = "fact" | "history" | "audit";

export interface DurableFileChange {
  readonly path: string;
  readonly role: DurableFileRole;
  readonly before?: string;
  readonly after?: string;
}

export interface RecoverableCommit {
  readonly commitId: string;
  readonly baseRevision: number;
  readonly nextRevision: number;
  readonly files: readonly DurableFileChange[];
}

export type FaultPoint =
  | "lock_before_journal"
  | "staging_incomplete"
  | "prepared"
  | "applying_before_first"
  | "applying:1"
  | "facts_complete_marker_gap"
  | "facts-applied"
  | "history:1"
  | "history-applied"
  | "audit:1"
  | "audit-applied"
  | "committed"
  | "cleanup_partial";

export interface RecoverablePersistenceOptions {
  readonly faultAt?: FaultPoint;
}

export interface RecoverableTransaction<T> {
  readonly commit?: RecoverableCommit;
  readonly result: T;
}

type JournalState = "prepared" | "applying" | "facts-applied" | "history-applied" | "audit-applied" | "committed" | "recovery-required";

interface JournalFile {
  path: string;
  role: DurableFileRole;
  beforeExists: boolean;
  afterExists: boolean;
  beforeDigest: string;
  afterDigest: string;
}

interface Journal {
  protocol: "toporealm.recoverable-commit/v1";
  commitId: string;
  baseRevision: number;
  nextRevision: number;
  state: JournalState;
  files: JournalFile[];
}

const LOCK_FILE = ".toporealm.lock";
const TRANSACTION_DIR = ".toporealm-txn";
const JOURNAL_FILE = "journal.json";

export class RecoverableGraphPersistence {
  constructor(readonly graphRoot: string, private readonly options: RecoverablePersistenceOptions = {}) {}

  runExclusive<T>(action: () => T): T {
    mkdirSync(this.graphRoot, { recursive: true });
    const lockPath = join(this.graphRoot, LOCK_FILE);
    const descriptor = this.acquireLock(lockPath);
    try {
      return action();
    } finally {
      closeSync(descriptor);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  }

  commit(commit: RecoverableCommit): void {
    this.runExclusive(() => {
      this.recoverUnlocked();
      this.commitUnlocked(commit);
    });
  }

  /**
   * Runs preparation and the durable commit while holding one graph lock.
   * Candidate construction and validation therefore cannot race the write.
   */
  transaction<T>(prepare: () => RecoverableTransaction<T>): T {
    return this.runExclusive(() => {
      this.recoverUnlocked();
      const prepared = prepare();
      if (prepared.commit) this.commitUnlocked(prepared.commit);
      return prepared.result;
    });
  }

  recover(): "none" | "rolled-back" | "recovered-complete" {
    return this.runExclusive(() => this.recoverUnlocked());
  }

  private recoverUnlocked(): "none" | "rolled-back" | "recovered-complete" {
    const journalPath = this.journalPath();
    if (!existsSync(journalPath)) {
      if (existsSync(join(this.graphRoot, TRANSACTION_DIR))) {
        this.cleanup();
        return "rolled-back";
      }
      return "none";
    }
    const journal = this.readJournal();
    const facts = journal.files.filter((file) => file.role === "fact");
    const classifications = facts.map((file) => this.classify(file));
    if (classifications.includes("unknown")) {
      journal.state = "recovery-required";
      this.writeJournal(journal);
      throw new CoreError({ code: "RECOVERY_REQUIRED", message: "事务期间检测到无法归类的外部文件变化。", details: { commitId: journal.commitId } });
    }
    const finalize = facts.length > 0 && classifications.every((item) => item === "new");
    if (journal.state === "committed" && finalize) {
      this.markRecoveryAudit(journal, "committed");
      this.cleanup();
      return "recovered-complete";
    }
    const side = finalize ? "new" : "old";
    for (const file of journal.files) this.applyStaged(file, side);
    this.markRecoveryAudit(journal, finalize ? "recovered-complete" : "rolled-back");
    this.cleanup();
    return finalize ? "recovered-complete" : "rolled-back";
  }

  private commitUnlocked(commit: RecoverableCommit): void {
    if (!commit.commitId || commit.nextRevision !== commit.baseRevision + 1 || commit.nextRevision < 0) {
      throw new CoreError({ code: "INVALID_COMMIT", message: "commitId 或 revision 区间无效。" });
    }
    const files = commit.files.map((file) => this.validateChange(file));
    for (const file of files) {
      const actual = readOptional(join(this.graphRoot, file.path));
      if (actual !== file.before) {
        throw new CoreError({ code: "EXTERNAL_EDIT_RACE", message: `提交前文件已变化：${file.path}`, details: { path: file.path } });
      }
    }
    this.fault("lock_before_journal");
    const journal = this.stage({ ...commit, files });
    this.fault("staging_incomplete");
    this.writeJournal(journal);
    this.fault("prepared");
    journal.state = "applying";
    this.writeJournal(journal);
    this.fault("applying_before_first");
    let appliedFacts = 0;
    for (const file of journal.files.filter((item) => item.role === "fact")) {
      this.applyStaged(file, "new");
      appliedFacts += 1;
      if (appliedFacts === 1) this.fault("applying:1");
    }
    this.fault("facts_complete_marker_gap");
    journal.state = "facts-applied";
    this.writeJournal(journal);
    this.fault("facts-applied");
    let appliedHistory = 0;
    for (const file of journal.files.filter((item) => item.role === "history")) {
      this.applyStaged(file, "new");
      appliedHistory += 1;
      if (appliedHistory === 1) this.fault("history:1");
    }
    journal.state = "history-applied";
    this.writeJournal(journal);
    this.fault("history-applied");
    let appliedAudit = 0;
    for (const file of journal.files.filter((item) => item.role === "audit")) {
      this.applyStaged(file, "new");
      appliedAudit += 1;
      if (appliedAudit === 1) this.fault("audit:1");
    }
    journal.state = "audit-applied";
    this.writeJournal(journal);
    this.fault("audit-applied");
    journal.state = "committed";
    this.writeJournal(journal);
    this.fault("committed");
    if (this.options.faultAt === "cleanup_partial") {
      rmSync(join(this.graphRoot, TRANSACTION_DIR, "new"), { recursive: true, force: true });
      this.fault("cleanup_partial");
    }
    this.cleanup();
  }

  private stage(commit: RecoverableCommit & { files: readonly DurableFileChange[] }): Journal {
    this.cleanup();
    const journalFiles: JournalFile[] = [];
    for (const file of commit.files) {
      this.writeStage("old", file.path, file.before);
      this.writeStage("new", file.path, file.after);
      journalFiles.push({
        path: file.path,
        role: file.role,
        beforeExists: file.before !== undefined,
        afterExists: file.after !== undefined,
        beforeDigest: digest(file.before),
        afterDigest: digest(file.after),
      });
    }
    return {
      protocol: "toporealm.recoverable-commit/v1",
      commitId: commit.commitId,
      baseRevision: commit.baseRevision,
      nextRevision: commit.nextRevision,
      state: "prepared",
      files: journalFiles,
    };
  }

  private classify(file: JournalFile): "old" | "new" | "unknown" {
    const actual = readOptional(join(this.graphRoot, file.path));
    const actualDigest = digest(actual);
    if (actualDigest === file.afterDigest && (actual !== undefined) === file.afterExists) return "new";
    if (actualDigest === file.beforeDigest && (actual !== undefined) === file.beforeExists) return "old";
    return "unknown";
  }

  private applyStaged(file: JournalFile, side: "old" | "new"): void {
    const exists = side === "old" ? file.beforeExists : file.afterExists;
    const target = join(this.graphRoot, file.path);
    if (!exists) {
      if (existsSync(target)) unlinkSync(target);
      return;
    }
    const staged = join(this.graphRoot, TRANSACTION_DIR, side, file.path);
    const content = readFileSync(staged, "utf8");
    const expected = side === "old" ? file.beforeDigest : file.afterDigest;
    if (digest(content) !== expected) throw new CoreError({ code: "RECOVERY_REQUIRED", message: `事务 staging 损坏：${file.path}` });
    writeAtomic(target, content);
  }

  private markRecoveryAudit(journal: Journal, recoveryStatus: "committed" | "recovered-complete" | "rolled-back"): void {
    for (const file of journal.files.filter((item) => item.role === "audit")) {
      const target = join(this.graphRoot, file.path);
      const current = readOptional(target) ?? "";
      const stagedNew = readOptional(join(this.graphRoot, TRANSACTION_DIR, "new", file.path)) ?? current;
      const candidate = parseAudit(stagedNew).records.find((item) => item.commitId === journal.commitId)
        ?? parseAudit(current).records.find((item) => item.commitId === journal.commitId);
      if (!candidate) continue;
      const next = { ...candidate, recoveryStatus };
      const parsed = parseAudit(current);
      const index = parsed.records.findIndex((item) => item.commitId === journal.commitId);
      if (index >= 0) parsed.records[index] = next;
      else parsed.records.push(next);
      writeAtomic(target, serializeAudit(parsed));
    }
  }

  private writeStage(side: "old" | "new", path: string, content: string | undefined): void {
    if (content === undefined) return;
    const target = join(this.graphRoot, TRANSACTION_DIR, side, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  private validateChange(file: DurableFileChange): DurableFileChange {
    const path = normalize(file.path).replaceAll("\\", "/");
    if (!path || isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("/../") || path === LOCK_FILE || path.startsWith(`${TRANSACTION_DIR}/`)) {
      throw new CoreError({ code: "INVALID_COMMIT_PATH", message: `事务文件路径无效：${file.path}` });
    }
    return { ...file, path };
  }

  private acquireLock(lockPath: string): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(lockPath, "wx");
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
        return descriptor;
      } catch (error) {
        if (!existsSync(lockPath)) throw error;
        const owner = readLockOwner(lockPath);
        if (owner !== undefined && owner !== process.pid && !processExists(owner)) {
          unlinkSync(lockPath);
          continue;
        }
        throw new GraphLockError(lockPath);
      }
    }
    throw new GraphLockError(lockPath);
  }

  private readJournal(): Journal {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.journalPath(), "utf8"));
    } catch (error) {
      throw new CoreError({ code: "RECOVERY_REQUIRED", message: "事务 journal 无法读取。", details: { cause: error instanceof Error ? error.message : String(error) } });
    }
    const journal = value as Partial<Journal>;
    if (journal.protocol !== "toporealm.recoverable-commit/v1" || !journal.commitId || !Array.isArray(journal.files)) {
      throw new CoreError({ code: "RECOVERY_REQUIRED", message: "事务 journal 形状无效。" });
    }
    return journal as Journal;
  }

  private writeJournal(journal: Journal): void {
    writeAtomic(this.journalPath(), JSON.stringify(journal, null, 2));
  }

  private journalPath(): string {
    return join(this.graphRoot, TRANSACTION_DIR, JOURNAL_FILE);
  }

  private cleanup(): void {
    const target = join(this.graphRoot, TRANSACTION_DIR);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }

  private fault(point: FaultPoint): void {
    if (this.options.faultAt === point) throw new Error(`FAULT_INJECTED:${point}`);
  }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function digest(content: string | undefined): string {
  return content === undefined ? "missing" : createHash("sha256").update(content).digest("hex");
}

interface ParsedAudit {
  kind: "array" | "jsonl";
  records: Array<Record<string, unknown>>;
}

function parseAudit(content: string): ParsedAudit {
  try {
    const value = JSON.parse(content) as unknown;
    if (Array.isArray(value)) return { kind: "array", records: value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) };
  } catch {
    // Production audit uses JSONL.
  }
  const records = content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  return { kind: "jsonl", records };
}

function serializeAudit(audit: ParsedAudit): string {
  return audit.kind === "array" ? JSON.stringify(audit.records) : `${audit.records.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function readLockOwner(path: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : undefined;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}
