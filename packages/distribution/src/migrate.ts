import fsp from "node:fs/promises";
import path from "node:path";
import {
  TopoError,
  isValidEntityId,
  isValidGraphId,
  kindNamespace,
  type Entity,
  type RelationEntity,
} from "@lukawi/toporealm-protocol";
import {
  graphPaths,
  loadManifest,
  saveManifest,
  writeActiveGraphId,
  writeEntity,
  workspacePaths,
} from "@lukawi/toporealm-daemon-core";
import { parse, stringify } from "yaml";

// ---------- 0.x → 1.0 一次性迁移（blueprint §6 / §1.6 D23③） ----------
//
// 输入：0.x 图目录（graph.yaml v1 + objects/ + relations/ + .revision.json）。
// 映射（机械，无判断）：
//   data 浅合并进 payload → capabilities 浅合并（与已落键冲突时更名 cap_<键> 并报告）
//   → label→payload.title → meta→payload.meta（嵌套降级）；kind/direction/id 原样；
//   revision 保留计数；undo 游标清零；历史不迁移（.log 从空开始）。
// 输出：新图目录 <root>/graphs/<图id>/（v2 清单最后写 = 迁移完成标记；同 new 选中）+
//   迁移报告（经 CLI 输出交付，不写报告文件进图目录）。--dry-run 只出报告不落盘。
// 全程文件层冷路径：不走 commit 管线（core 执法两条管运行期提交，迁移后的悬空边
// 照迁并单列清单，daemon 装载不受影响——悬空检查只发生在新提交）。

const OBJECT_FIELDS = new Set(["id", "kind", "label", "data", "capabilities", "meta"]);
const RELATION_FIELDS = new Set(["id", "kind", "source", "target", "direction", "label", "data", "capabilities", "meta"]);

export interface MigrateOptions {
  root: string;
  /** 0.x 图目录（含 graph.yaml v1 / objects/ / relations/ / .revision.json） */
  oldDir: string;
  /** 只出报告不落盘、不选中 */
  dryRun?: boolean;
}

export type ConflictType =
  | "data-vs-capabilities"
  | "label-vs-payload"
  | "meta-vs-payload";

export interface MigrationConflict {
  entity: string;
  kind: string;
  type: ConflictType;
  key: string;
  resolution: string;
}

export interface MigrationDegradation {
  entity?: string;
  detail: string;
}

export interface MigrationErrorEntry {
  entity?: string;
  file?: string;
  detail: string;
}

export interface ModuleDeclarationProjection {
  id: string;
  namespace: string;
  schema?: number;
  /** module.yaml v2 投影（YAML 文本；version/entry 为占位，由模块本体仓库回填） */
  declaration: string;
  placeholders: string[];
}

export interface MigrationReport {
  source: string;
  target: string;
  dryRun: boolean;
  graph: { id: string; label?: string; revision: number; undoCursor: 0 };
  objects: { migrated: number; skipped: number };
  relations: { migrated: number; skipped: number };
  conflicts: MigrationConflict[];
  degradations: MigrationDegradation[];
  /** 悬空关系照迁，单列点名 */
  dangling: string[];
  errors: MigrationErrorEntry[];
  modules: ModuleDeclarationProjection[];
}

interface OldGraphV1 {
  format: string;
  id: string;
  label?: string;
  modules?: { id: string; namespace: string; schema?: number }[];
  meta?: unknown;
}

// ---------- v1 清单与实体解析 ----------

async function parseOldManifest(oldDir: string): Promise<OldGraphV1> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(oldDir, "graph.yaml"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TopoError({
        code: "GRAPH_NOT_FOUND",
        message: `旧图目录缺少 graph.yaml：${oldDir}`,
        hint: "migrate 的输入是 0.x 图目录（graph.yaml v1 + objects/ + relations/ + .revision.json）",
      });
    }
    throw err;
  }
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || raw["format"] !== "toporealm.graph/v1") {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `graph.yaml 不是 toporealm.graph/v1：${oldDir}`,
      hint: "1.0 图无需迁移；migrate 只接受 0.x v1 格式",
      details: { format: String(raw?.["format"] ?? "") },
    });
  }
  if (typeof raw["id"] !== "string" || raw["id"].length === 0) {
    throw new TopoError({ code: "INVALID_INPUT", message: "graph.yaml v1 缺少 id" });
  }
  return {
    format: "toporealm.graph/v1",
    id: raw["id"],
    ...(typeof raw["label"] === "string" ? { label: raw["label"] } : {}),
    ...(Array.isArray(raw["modules"]) ? { modules: raw["modules"] as OldGraphV1["modules"] } : {}),
    ...(raw["meta"] !== undefined ? { meta: raw["meta"] } : {}),
  };
}

async function readRevisionCount(oldDir: string, degradations: MigrationDegradation[]): Promise<number> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(oldDir, ".revision.json"), "utf8")) as {
      revision?: unknown;
    };
    const n = Number(raw.revision);
    if (!Number.isFinite(n) || n < 0) throw new Error("bad count");
    return Math.floor(n);
  } catch {
    degradations.push({ detail: ".revision.json 缺失或不可读：revision 按 0 计" });
    return 0;
  }
}

interface EntityParse {
  rec?: Entity | RelationEntity;
  error?: string;
}

function migrateEntity(
  file: string,
  raw: Record<string, unknown> | null,
  expectRelation: boolean,
  conflicts: MigrationConflict[],
  degradations: MigrationDegradation[],
): EntityParse {
  if (!raw || typeof raw !== "object") {
    return { error: "文件不是 YAML 映射" };
  }
  const id = raw["id"];
  const kind = raw["kind"];
  if (typeof id !== "string" || id.length === 0) return { error: "缺少 id" };
  if (!isValidEntityId(id)) return { error: `id 非法（文件名安全规则）："${id}"` };
  const base = path.basename(file, ".yaml");
  if (id !== base) return { error: `文件名 "${base}" 与实体 id "${id}" 不一致` };
  if (typeof kind !== "string" || kind.length === 0) return { error: "缺少 kind（1.0 kind 必填，机械迁移不做推断）" };

  const payload: Record<string, unknown> = {};

  // ① data 浅合并（data 优先）
  if (raw["data"] !== undefined) {
    if (raw["data"] === null || typeof raw["data"] !== "object" || Array.isArray(raw["data"])) {
      return { error: "data 不是映射" };
    }
    Object.assign(payload, raw["data"]);
  }
  // ② capabilities 浅合并；键冲突 → 更名 cap_<键> 并报告（D23③）
  if (raw["capabilities"] !== undefined) {
    if (raw["capabilities"] === null || typeof raw["capabilities"] !== "object" || Array.isArray(raw["capabilities"])) {
      return { error: "capabilities 不是映射" };
    }
    for (const [k, v] of Object.entries(raw["capabilities"] as Record<string, unknown>)) {
      if (k in payload) {
        const renamed = `cap_${k}`;
        conflicts.push({
          entity: id,
          kind,
          type: "data-vs-capabilities",
          key: k,
          resolution: `data 优先；capabilities 条目更名 "${renamed}" 落位`,
        });
        payload[renamed] = v;
      } else {
        payload[k] = v;
      }
    }
  }
  // ③ label → payload.title（冲突：已落载荷优先，label 值记录于报告）
  if (raw["label"] !== undefined) {
    if (typeof raw["label"] !== "string") {
      degradations.push({ entity: id, detail: "label 非字符串，未迁移" });
    } else if ("title" in payload) {
      conflicts.push({
        entity: id,
        kind,
        type: "label-vs-payload",
        key: "title",
        resolution: `payload 已有 title（data/capabilities 优先）；label 值 "${raw["label"]}" 记录于报告后放弃`,
      });
    } else {
      payload["title"] = raw["label"];
    }
  }
  // ④ meta → payload.meta 嵌套降级
  if (raw["meta"] !== undefined) {
    if (raw["meta"] === null || typeof raw["meta"] !== "object" || Array.isArray(raw["meta"])) {
      degradations.push({ entity: id, detail: "meta 不是映射，未迁移" });
    } else if ("meta" in payload) {
      conflicts.push({
        entity: id,
        kind,
        type: "meta-vs-payload",
        key: "meta",
        resolution: "payload 已有 meta（data/capabilities 优先）；meta 对象记录于报告后放弃",
      });
      degradations.push({ entity: id, detail: `meta 对象被放弃：${JSON.stringify(raw["meta"])}` });
    } else {
      payload["meta"] = raw["meta"];
    }
  }
  // ⑤ 清单外顶层字段：丢弃并报告（旧图可由 0.x 随时回看）
  const known = expectRelation ? RELATION_FIELDS : OBJECT_FIELDS;
  const unexpected = Object.keys(raw).filter((k) => !known.has(k));
  for (const k of unexpected) {
    degradations.push({ entity: id, detail: `清单外字段 "${k}" 丢弃（值：${JSON.stringify(raw[k])?.slice(0, 120)}）` });
  }

  if (!expectRelation) {
    return { rec: { id, kind, payload } };
  }
  if (typeof raw["source"] !== "string" || typeof raw["target"] !== "string") {
    return { error: "关系缺少 source/target" };
  }
  const rawDirection = raw["direction"];
  if (rawDirection !== undefined && rawDirection !== "directed" && rawDirection !== "undirected") {
    return { error: `direction 非法："${String(rawDirection)}"` };
  }
  const direction = rawDirection === "directed" || rawDirection === "undirected" ? rawDirection : undefined;
  return {
    rec: {
      id,
      kind,
      source: raw["source"],
      target: raw["target"],
      ...(direction !== undefined ? { direction } : {}),
      payload,
    } satisfies RelationEntity,
  };
}

async function readEntities(
  dir: string,
  expectRelation: boolean,
  seen: Set<string>,
  conflicts: MigrationConflict[],
  degradations: MigrationDegradation[],
  errors: MigrationErrorEntry[],
): Promise<{ migrated: (Entity | RelationEntity)[]; skipped: number }> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".yaml")).sort();
  } catch {
    names = [];
  }
  const migrated: (Entity | RelationEntity)[] = [];
  let skipped = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: Record<string, unknown> | null;
    try {
      raw = parse(await fsp.readFile(file, "utf8")) as Record<string, unknown> | null;
    } catch (err) {
      errors.push({ file: name, detail: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}` });
      skipped++;
      continue;
    }
    const r = migrateEntity(file, raw, expectRelation, conflicts, degradations);
    if (r.error !== undefined || r.rec === undefined) {
      errors.push({ entity: typeof raw?.["id"] === "string" ? raw["id"] : undefined, file: name, detail: r.error ?? "未知解析失败" });
      skipped++;
      continue;
    }
    if (seen.has(r.rec.id)) {
      errors.push({ entity: r.rec.id, file: name, detail: "id 与已迁移实体重复（0.x 要求图内唯一）；本文件跳过" });
      skipped++;
      continue;
    }
    seen.add(r.rec.id);
    migrated.push(r.rec);
  }
  return { migrated, skipped };
}

// ---------- 模块引用升级：v2 声明投影 ----------

function projectModuleDeclarations(
  mods: NonNullable<OldGraphV1["modules"]>,
  objects: readonly Entity[],
  relations: readonly RelationEntity[],
): ModuleDeclarationProjection[] {
  return mods.map((m) => {
    const objKinds = new Set<string>();
    const relKinds = new Set<string>();
    for (const o of objects) {
      if (kindNamespace(o.kind) === m.namespace) objKinds.add(o.kind.slice(m.namespace.length + 1));
    }
    for (const r of relations) {
      if (kindNamespace(r.kind) === m.namespace) relKinds.add(r.kind.slice(m.namespace.length + 1));
    }
    const declaration: Record<string, unknown> = {
      format: "toporealm.module/v2",
      id: m.id,
      namespace: m.namespace,
      version: "0.0.0",
      requires: { modules: [] },
      kinds: {
        ...(objKinds.size > 0 ? { objects: [...objKinds].sort() } : {}),
        ...(relKinds.size > 0 ? { relations: [...relKinds].sort() } : {}),
      },
      entry: "./index.js",
    };
    return {
      id: m.id,
      namespace: m.namespace,
      ...(m.schema !== undefined ? { schema: m.schema } : {}),
      declaration: stringify(declaration, { lineWidth: 0 }),
      placeholders: ["version（0.x 图清单只记录 schema，模块版本由本体仓库回填）", "entry（代码层入口由本体仓库回填）"],
    };
  });
}

// ---------- 入口 ----------

export async function migrateGraph(opts: MigrateOptions): Promise<MigrationReport> {
  const oldDir = path.resolve(opts.oldDir);
  const manifest = await parseOldManifest(oldDir);
  if (!isValidGraphId(manifest.id)) {
    throw new TopoError({
      code: "INVALID_INPUT",
      message: `旧图 id 不能用作 1.0 图目录名："${manifest.id}"（禁 / \\ : 空格与控制字符）`,
      hint: "先在 0.x 图里改 id（或复制目录后改 graph.yaml 的 id），再 migrate",
    });
  }

  const conflicts: MigrationConflict[] = [];
  const degradations: MigrationDegradation[] = [];
  const errors: MigrationErrorEntry[] = [];

  // graph 级：v1 顶层 meta 在 v2 清单无对应字段 → 降级报告
  if (manifest.meta !== undefined) {
    degradations.push({ detail: `graph.yaml v1 顶层 meta 丢弃（v2 清单无 meta）：${JSON.stringify(manifest.meta)}` });
  }
  const revision = await readRevisionCount(oldDir, degradations);

  const seen = new Set<string>();
  const objs = await readEntities(path.join(oldDir, "objects"), false, seen, conflicts, degradations, errors);
  const rels = await readEntities(path.join(oldDir, "relations"), true, seen, conflicts, degradations, errors);
  const objects = objs.migrated.filter((e): e is Entity => !("source" in e));
  const relations = rels.migrated.filter((e): e is RelationEntity => "source" in e);

  const objectIds = new Set(objects.map((o) => o.id));
  const dangling = relations.filter((r) => !objectIds.has(r.source) || !objectIds.has(r.target)).map((r) => r.id);

  const moduleProjections = projectModuleDeclarations(manifest.modules ?? [], objects, relations);

  const target = graphPaths(opts.root, manifest.id);
  const report: MigrationReport = {
    source: oldDir,
    target: target.dir,
    dryRun: opts.dryRun === true,
    graph: {
      id: manifest.id,
      ...(manifest.label !== undefined ? { label: manifest.label } : {}),
      revision,
      undoCursor: 0,
    },
    objects: { migrated: objects.length, skipped: objs.skipped },
    relations: { migrated: relations.length, skipped: rels.skipped },
    conflicts,
    degradations,
    dangling,
    errors,
    modules: moduleProjections,
  };

  if (opts.dryRun === true) return report;

  // 幂等保护：目标已存在（且是合法 v2 图）→ 拒绝覆盖
  try {
    await fsp.access(target.manifest);
    await loadManifest(target); // 可装载 = 已是 v2 图
    throw new TopoError({
      code: "ID_EXISTS",
      message: `图 "${manifest.id}" 已存在于工作区：${target.dir}`,
      hint: "migrate 不覆盖既有图；换 id 或删除后重试",
    });
  } catch (err) {
    if (TopoError.is(err)) throw err;
    // ENOENT：目标不存在或不是 v2 图 → 继续写入
  }

  const ws = workspacePaths(opts.root);
  await fsp.mkdir(target.objects, { recursive: true });
  await fsp.mkdir(target.relations, { recursive: true });
  for (const rec of [...objects, ...relations]) {
    await writeEntity(target, rec);
  }
  await fsp.writeFile(target.log, "", { flag: "wx" }).catch(() => {});
  // graph.yaml 最后写 = 迁移完成标记（同 daemon 原子写序）
  await saveManifest(target, {
    format: "toporealm.graph/v3",
    id: manifest.id,
    ...(manifest.label !== undefined ? { label: manifest.label } : {}),
    revision,
    undoCursor: 0,
  });
  // 同 new：迁完即选中
  await writeActiveGraphId(ws.activeFile, manifest.id);
  return report;
}
