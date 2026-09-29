#!/usr/bin/env node
// scripts/migrate-report-of.mjs —— 一次性迁移脚本（留仓归档，跑完可删）：
// 给历史 wf.execution_report 对象补建 wf.report_of 挂靠关系。
// 背景：workflow 模块 1.1.0 语义升级——报告挂靠改「同提交双写」（报告对象与挂靠边
// 同一提交原子落地，blueprint §7 / docs/adr/0009 D46）；存量报告须补边。
//
// 红线：单属主 daemon 是图文件唯一写者——本脚本绝不直写图文件，一切读写经
// @lukawi/toporealm-client 的 DaemonClient（IpcClient：自动拉起/复用 daemon）。
//
// 逻辑：read 全图 → 找 kind "wf.execution_report" 且 payload.taskId 指向图内存在对象的报告
// → 生成 change { op:"rel", kind:"wf.report_of", id:"rel-of-"+报告id, source:报告id,
//   target:taskId, direction:"directed", payload:{} } → 已存在同 id 关系跳过（幂等）
// → 分批 commit（每批 ≤20 changes，ifRevision 护航；IF_REVISION_MISMATCH 重读重试，
//   上限 3 次重试）→ 结束打印统计（扫描/命中/跳过/已建）。
// 旧数据 wf.checkpoint 独立对象只打印警告、不迁移（1.1.0 已内嵌任务 payload.checkpoints）。
//
// 用法（连接目标解析与 CLI 同规：--root/--graph 旗标 > TOPOREALM_ROOT/TOPOREALM_GRAPH
// > cwd 下的 .toporealm 工作区选定图）：
//   node --import tsx scripts/migrate-report-of.mjs [--root <dir>] [--graph <id>] [--dry-run]
//   （tsx 先例同 scripts/demo.ts / npm run demo：聚合包 client 的导出面指向 .ts 源）
// 示例：
//   node --import tsx scripts/migrate-report-of.mjs --dry-run   # 只打印将建清单与统计，不提交
//   node --import tsx scripts/migrate-report-of.mjs             # 实迁；幂等，可重跑

import { IpcClient } from "@lukawi/toporealm-client";
import { TopoError } from "@lukawi/toporealm-protocol";

const REPORT_KIND = "wf.execution_report";
const REL_KIND = "wf.report_of";
const CHECKPOINT_KIND = "wf.checkpoint";
const REL_ID_PREFIX = "rel-of-";
const BATCH_SIZE = 20; // 每批 commit 的 changes 上限
const MAX_RETRIES = 3; // 每批 IF_REVISION_MISMATCH 后的重读重试上限（共至多 1+3 次提交尝试）
const WARN_LIST_CAP = 10; // 警告列表最多逐个列出的 id 数

function parseArgv(argv) {
  const opts = { root: undefined, graph: undefined, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`参数 ${a} 缺值`);
      i++;
      return v;
    };
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--root") opts.root = value();
    else if (a === "--graph") opts.graph = value();
    else throw new Error(`未知参数 "${a}"（可用：--root <dir> --graph <id> --dry-run --help）`);
  }
  return opts;
}

function printHelp() {
  console.log(`migrate-report-of —— 给历史 wf.execution_report 补建 wf.report_of（一次性迁移）

用法：
  node --import tsx scripts/migrate-report-of.mjs [--root <dir>] [--graph <id>] [--dry-run]

选项：
  --root <dir>   目标工作区（缺省 $TOPOREALM_ROOT / cwd）
  --graph <id>   目标图（缺省 $TOPOREALM_GRAPH / 工作区选定图）
  --dry-run      只打印将建清单与统计，不提交
  --help         本帮助

说明：经 DaemonClient 走 daemon（单属主红线，绝不直写图文件）；幂等可重跑——
同 id（rel-of-<报告id>）关系已存在即跳过；wf.checkpoint 独立对象（旧数据）只警告不迁移。`);
}

/** 对象记录（判别：关系记录带 source 字段；对象与关系共用 id 空间） */
const isObjectRecord = (e) => e != null && typeof e === "object" && !("source" in e);
/** IF_REVISION_MISMATCH 识别（IPC 错误经 TopoError.fromJSON 重建，instanceof 成立；码值兜底） */
const isRevisionMismatch = (err) =>
  err instanceof TopoError ? err.code === "IF_REVISION_MISMATCH" : err?.code === "IF_REVISION_MISMATCH";

/**
 * 全图扫描：命中 = 报告对象 + payload.taskId 为非空字符串 + taskId 指向图内存在的对象。
 * 返回统计与「将建」清单（已按同 id 关系存在与否分好跳过）。
 */
function scan(entities) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const stats = {
    scanned: 0, // 扫描的报告对象数
    hit: 0, // 命中（taskId 有效且目标在图内）
    skipped: 0, // 跳过（同 id 关系已存在；实迁期竞态剔除另计入）
    missingTaskId: 0, // 未命中：缺 payload.taskId
    missingTarget: 0, // 未命中：taskId 目标不在图内
    created: 0, // 已建（dry-run 恒 0）
    checkpoints: [], // wf.checkpoint 独立对象 id（只警告不迁移）
  };
  const toCreate = [];
  for (const e of entities) {
    if (!isObjectRecord(e)) continue;
    if (e.kind === CHECKPOINT_KIND) stats.checkpoints.push(e.id);
    if (e.kind !== REPORT_KIND) continue;
    stats.scanned++;
    const taskId = e.payload?.taskId;
    if (typeof taskId !== "string" || taskId === "") {
      stats.missingTaskId++;
      continue;
    }
    const target = byId.get(taskId);
    if (!isObjectRecord(target)) {
      stats.missingTarget++;
      continue;
    }
    stats.hit++;
    const relId = REL_ID_PREFIX + e.id;
    // 幂等：rel id 与对象 id 共用 id 空间，任一占用都跳过（rel 重提交 = upsert，会覆写）
    if (byId.has(relId)) {
      stats.skipped++;
      continue;
    }
    toCreate.push({ relId, reportId: e.id, taskId });
  }
  return { stats, toCreate };
}

const changeOf = (p) => ({
  op: "rel",
  kind: REL_KIND,
  id: p.relId,
  source: p.reportId,
  target: p.taskId,
  direction: "directed",
  payload: {},
});

/** 分批提交：每批 ≤ BATCH_SIZE；每轮先重读全图做幂等/端点复核，ifRevision 护航提交 */
async function commitBatches(session, toCreate) {
  let created = 0;
  let skipped = 0;
  const countedSkipped = new Set(); // 竞态剔除只计一次（重试轮会重算同一批）
  const batches = Math.max(1, Math.ceil(toCreate.length / BATCH_SIZE));
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    const batchNo = Math.floor(i / BATCH_SIZE) + 1;
    let retries = 0;
    for (;;) {
      const fresh = await session.read();
      const ids = new Set(fresh.entities.map((e) => e.id));
      const sendable = batch.filter(
        (p) => !ids.has(p.relId) && ids.has(p.reportId) && ids.has(p.taskId),
      );
      for (const p of batch) {
        if (!sendable.includes(p) && !countedSkipped.has(p.relId)) {
          countedSkipped.add(p.relId);
          skipped++;
        }
      }
      if (sendable.length === 0) break;
      try {
        const res = await session.commit({
          changes: sendable.map(changeOf),
          ifRevision: fresh.revision,
          label: `migrate-report-of: 批次 ${batchNo}/${batches} 补建 ${REL_KIND} × ${sendable.length}`,
        });
        created += sendable.length;
        console.log(`  批次 ${batchNo}/${batches}：已建 ${sendable.length} 条 → revision ${res.revision}`);
        break;
      } catch (err) {
        if (isRevisionMismatch(err) && retries < MAX_RETRIES) {
          retries++;
          console.warn(
            `  批次 ${batchNo}/${batches}：IF_REVISION_MISMATCH，重读全图重试（${retries}/${MAX_RETRIES}）……`,
          );
          continue;
        }
        throw err;
      }
    }
  }
  return { created, skipped };
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  const client = new IpcClient();
  const session = await client.connect({
    ...(opts.root !== undefined ? { root: opts.root } : {}),
    ...(opts.graph !== undefined ? { graph: opts.graph } : {}),
  });
  try {
    const full = await session.read();
    const { stats, toCreate } = scan(full.entities);

    console.log(`# migrate-report-of —— ${REPORT_KIND} → ${REL_KIND} 一次性迁移`);
    console.log(
      `图 "${session.graphId}"（revision ${full.revision}）· 模式：${opts.dryRun ? "DRY-RUN（只打印，不提交）" : "实迁"}`,
    );
    console.log(
      `扫描 ${stats.scanned} · 命中 ${stats.hit} · 跳过 ${stats.skipped} · 已建 ${stats.created}` +
        ` · 未命中（缺 payload.taskId ${stats.missingTaskId} / taskId 目标不在图内 ${stats.missingTarget}）`,
    );
    if (stats.checkpoints.length > 0) {
      const shown = stats.checkpoints.slice(0, WARN_LIST_CAP).join(", ");
      const more = stats.checkpoints.length > WARN_LIST_CAP ? ` …等 ${stats.checkpoints.length} 个` : "";
      console.warn(
        `⚠ 发现 ${stats.checkpoints.length} 个 ${CHECKPOINT_KIND} 独立对象（旧数据；1.1.0 已内嵌任务 ` +
          `payload.checkpoints，不迁移）：${shown}${more}`,
      );
    }

    if (opts.dryRun) {
      console.log(`-- dry-run 将建清单（${toCreate.length} 条，不提交）--`);
      for (const p of toCreate) {
        console.log(`  ${p.relId}: ${p.reportId} -> ${p.taskId}（${REL_KIND}，directed）`);
      }
      console.log(`✓ dry-run 结束：将建 ${toCreate.length} · 已建 0（未提交任何变更）`);
      return 0;
    }

    if (toCreate.length === 0) {
      console.log("✓ 无需迁移：没有待建的 wf.report_of 关系（幂等重跑亦走此路径）");
      return 0;
    }
    const { created, skipped } = await commitBatches(session, toCreate);
    console.log(
      `✓ 完成：扫描 ${stats.scanned} · 命中 ${stats.hit} · 跳过 ${stats.skipped + skipped} · 已建 ${created}`,
    );
    return 0;
  } finally {
    await session.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof TopoError) {
      console.error(`✗ 迁移失败 [${err.code}]：${err.message}${err.fix ? `\n  fix: ${err.fix}` : ""}`);
    } else {
      console.error(`✗ 迁移失败：${err?.stack ?? String(err)}`);
    }
    process.exitCode = 1;
  });
