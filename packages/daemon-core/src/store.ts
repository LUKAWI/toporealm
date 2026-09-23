import fsp from "node:fs/promises";
import path from "node:path";
import { stringify, parse } from "yaml";
import {
  TopoError,
  isValidEntityId,
  type Change,
  type Entity,
  type EntityId,
  type GraphPatch,
  type Origin,
  type RelationEntity,
  type StoredLogEntry,
} from "@lukawi/toporealm-protocol";
import type { GraphPaths } from "./paths.js";

// ---------- 磁盘格式（blueprint §3）：YAML 存储 + 原子写 + JSONL 提交日志 ----------

export interface GraphManifestV2 {
  format: "toporealm.graph/v2";
  id: string;
  label?: string;
  revision: number;
  /** 已应用日志条数（undo/redo 游标；undo/redo 移游标不追加日志，D17 裁决②） */
  undoCursor: number;
  modules: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 原子写 = 同目录临时文件 + rename。
 * Windows 语义（blueprint §3 红线）：rename 前绝不 unlink 目标（Node 的 rename 在
 * Windows 上即 MoveFileEx(REPLACE_EXISTING)）；EPERM/EACCES/EBUSY（杀软/索引器瞬时
 * 锁）短退避重试。临时文件固定落在同目录保证同卷，rename 才可能原子。
 */
export async function atomicWriteFile(
  file: string,
  data: string,
): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );
  await fsp.writeFile(tmp, data, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        attempt < 4 &&
        (code === "EPERM" || code === "EACCES" || code === "EBUSY")
      ) {
        await sleep(10 * 2 ** attempt);
        continue;
      }
      try {
        await fsp.unlink(tmp);
      } catch {
        /* 清理失败不影响抛错 */
      }
      throw err;
    }
  }
}

// ---------- graph.yaml ----------

export async function loadManifest(
  p: GraphPaths,
): Promise<GraphManifestV2> {
  let text: string;
  try {
    text = await fsp.readFile(p.manifest, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TopoError({
        code: "GRAPH_NOT_FOUND",
        message: `图不存在或缺少 graph.yaml：${p.dir}`,
        hint: "图目录必须包含 toporealm.graph/v2 格式的 graph.yaml",
        fix: "toporealm new <graph>",
      });
    }
    throw err;
  }
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || raw.format !== "toporealm.graph/v2") {
    throw new TopoError({
      code: "GRAPH_NOT_FOUND",
      message: "graph.yaml 不是 toporealm.graph/v2 格式",
      hint: "1.0 daemon 只读 v2 格式；0.x 旧图由 toporealm migrate 迁移（M4 交付）",
    });
  }
  return {
    format: "toporealm.graph/v2",
    id: String(raw.id ?? ""),
    ...(raw.label !== undefined ? { label: String(raw.label) } : {}),
    revision: Number(raw.revision) || 0,
    undoCursor: Number(raw.undoCursor) || 0,
    modules: Array.isArray(raw.modules) ? raw.modules.map(String) : [],
  };
}

export function manifestYaml(m: GraphManifestV2): string {
  const doc: Record<string, unknown> = {
    format: m.format,
    id: m.id,
    ...(m.label !== undefined ? { label: m.label } : {}),
    revision: m.revision,
    undoCursor: m.undoCursor,
    modules: m.modules,
  };
  return stringify(doc, { lineWidth: 0 });
}

export async function saveManifest(
  p: GraphPaths,
  m: GraphManifestV2,
): Promise<void> {
  // graph.yaml 最后写：它是"本次转换已落盘"的标记
  await atomicWriteFile(p.manifest, manifestYaml(m));
}

export async function createGraphDir(
  p: GraphPaths,
  m: GraphManifestV2,
): Promise<void> {
  await fsp.mkdir(p.objects, { recursive: true });
  await fsp.mkdir(p.relations, { recursive: true });
  await saveManifest(p, m);
  try {
    await fsp.writeFile(p.log, "", { flag: "wx" });
  } catch {
    /* 已存在则忽略 */
  }
}

// ---------- 实体文件（每实体一 YAML） ----------

export function objectFile(p: GraphPaths, id: EntityId): string {
  return path.join(p.objects, `${id}.yaml`);
}

export function relationFile(p: GraphPaths, id: EntityId): string {
  return path.join(p.relations, `${id}.yaml`);
}

export function entityYaml(rec: Entity | RelationEntity): string {
  const doc: Record<string, unknown> = { id: rec.id, kind: rec.kind };
  if ("source" in rec) {
    doc.source = rec.source;
    doc.target = rec.target;
    if (rec.direction !== undefined) doc.direction = rec.direction;
  }
  doc.payload = rec.payload;
  return stringify(doc, { lineWidth: 0 });
}

async function parseEntityFile(
  file: string,
  expectRelation: boolean,
): Promise<{ id: EntityId; rec: Entity | RelationEntity } | null> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const raw = parse(text) as Record<string, unknown> | null;
  const base = path.basename(file, ".yaml");
  if (
    !raw ||
    typeof raw.id !== "string" ||
    typeof raw.kind !== "string" ||
    raw.id !== base ||
    !isValidEntityId(raw.id) ||
    typeof raw.payload !== "object" ||
    raw.payload === null
  ) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `实体文件损坏或与文件名不符：${file}`,
      hint: "每实体一 YAML，文件名必须等于实体 id；payload 必须是映射",
    });
  }
  const payload = raw.payload as Record<string, unknown>;
  if (!expectRelation) {
    return { id: raw.id, rec: { id: raw.id, kind: raw.kind, payload } };
  }
  if (
    typeof raw.source !== "string" ||
    typeof raw.target !== "string" ||
    (raw.direction !== undefined && raw.direction !== "directed" && raw.direction !== "undirected")
  ) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `关系文件缺少合法 source/target：${file}`,
    });
  }
  return {
    id: raw.id,
    rec: {
      id: raw.id,
      kind: raw.kind,
      source: raw.source,
      target: raw.target,
      ...(raw.direction !== undefined
        ? { direction: raw.direction as "directed" | "undirected" }
        : {}),
      payload,
    },
  };
}

export async function loadEntities(
  p: GraphPaths,
): Promise<{ objects: Map<EntityId, Entity>; relations: Map<EntityId, RelationEntity> }> {
  const objects = new Map<EntityId, Entity>();
  const relations = new Map<EntityId, RelationEntity>();
  for (const [dir, expectRelation, into] of [
    [p.objects, false, objects] as const,
    [p.relations, true, relations] as const,
  ]) {
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".yaml")) continue;
      const parsed = await parseEntityFile(
        path.join(dir, name),
        expectRelation,
      );
      if (parsed) into.set(parsed.id, parsed.rec as never);
    }
  }
  return { objects, relations };
}

export async function writeEntity(
  p: GraphPaths,
  rec: Entity | RelationEntity,
): Promise<void> {
  const file = "source" in rec ? relationFile(p, rec.id) : objectFile(p, rec.id);
  await atomicWriteFile(file, entityYaml(rec));
}

export async function removeEntityFile(
  p: GraphPaths,
  id: EntityId,
  expectRelation: boolean,
): Promise<void> {
  const file = expectRelation ? relationFile(p, id) : objectFile(p, id);
  try {
    await fsp.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---------- .log（append-only JSONL；行 = LogEntry 超集） ----------

export async function appendLogLine(
  p: GraphPaths,
  entry: StoredLogEntry,
): Promise<void> {
  await fsp.mkdir(p.dir, { recursive: true });
  await fsp.appendFile(p.log, JSON.stringify(entry) + "\n", "utf8");
}

export async function rewriteLog(
  p: GraphPaths,
  entries: readonly StoredLogEntry[],
): Promise<void> {
  const text =
    entries.length === 0
      ? ""
      : entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await atomicWriteFile(p.log, text);
}

export async function readLog(
  p: GraphPaths,
): Promise<StoredLogEntry[]> {
  let text: string;
  try {
    text = await fsp.readFile(p.log, "utf8");
  } catch {
    return [];
  }
  const out: StoredLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const e = JSON.parse(line) as StoredLogEntry;
      if (
        typeof e.revision === "number" &&
        typeof e.kind === "string" &&
        Array.isArray(e.changes) &&
        Array.isArray(e.inverse)
      ) {
        out.push(e);
      }
    } catch {
      /* 跳过残行 */
    }
  }
  return out;
}

// 类型再出口（core.ts 复用）
export type { Change, Entity, EntityId, GraphPatch, Origin, RelationEntity, StoredLogEntry };
