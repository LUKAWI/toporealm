import process from "node:process";
import path from "node:path";
import {
  endpointAddress,
  readActiveGraphId,
  workspacePaths,
} from "@lukawi/toporealm-daemon-core";
import { serveDaemon } from "../server.js";
import {
  clearEndpoint,
  isPidAlive,
  readEndpoint,
  writeEndpoint,
} from "../runtime.js";

// ---------- toporeald：单属主 daemon 可执行入口（blueprint §5 生命周期） ----------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let root: string = process.cwd();
  let graph: string | undefined;
  let idleMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i] ?? root;
    else if (a === "--graph") graph = argv[++i];
    else if (a === "--idle-ms") idleMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: toporeald [--root <dir>] [--graph <id>] [--idle-ms <ms>]\n" +
          "  --root     工作区目录（默认 cwd）\n" +
          "  --graph    服务哪张图（默认 .toporealm/active）\n" +
          "  --idle-ms  空闲退出毫秒；0 = 永不（默认 TOPOREALM_IDLE_MS 或 30000）\n",
      );
      return 0;
    }
  }
  root = path.resolve(root);
  if (idleMs === undefined || Number.isNaN(idleMs)) {
    const env = Number(process.env.TOPOREALM_IDLE_MS);
    idleMs = Number.isFinite(env) ? env : 30_000;
  }
  graph ??= (await readActiveGraphId(workspacePaths(root).activeFile)) ?? undefined;
  if (!graph) {
    process.stderr.write(
      "toporeald: 工作区没有激活的图（用 --graph <id>，或先 toporealm use <graph>）\n",
    );
    return 2;
  }

  // 单属主互斥：endpoint 存在且 pid 存活 → 拒绝双开
  const existing = await readEndpoint(root);
  if (existing && isPidAlive(existing.pid)) {
    process.stderr.write(
      `toporeald: daemon 已在运行 (pid ${existing.pid})：${existing.address}，服务图 "${existing.graphId}"\n`,
    );
    return 1;
  }

  let running;
  try {
    running = await serveDaemon({ root, graph, idleMs });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      process.stderr.write(
        `toporeald: endpoint 被占用（可能有并存 daemon）：${endpointAddress(root).address}\n`,
      );
      return 1;
    }
    process.stderr.write(`toporeald: 启动失败：${String(err)}\n`);
    return 1;
  }

  const ep = endpointAddress(root);
  await writeEndpoint(root, {
    transport: ep.transport,
    address: ep.address,
    pid: process.pid,
    instanceId: running.instanceId,
    graphId: running.graphId,
    startedAt: new Date().toISOString(),
  });
  process.stderr.write(
    `[toporeald] graph "${running.graphId}" ready (pid ${process.pid}, cold ${running.loadMs.toFixed(1)}ms, idle ${idleMs}ms, modules ${running.modules.length}${running.modules.length > 0 ? `: ${running.modules.join(", ")}` : ""})\n`,
  );
  for (const w of running.warnings) {
    process.stderr.write(`[toporeald] warning: ${w}\n`);
  }

  const cleanup = (): void => {
    void running.stop();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await running.stopped;
  await clearEndpoint(root).catch(() => {});
  return 0;
}

process.exit(await main());
