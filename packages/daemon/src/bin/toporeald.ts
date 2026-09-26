import process from "node:process";
import path from "node:path";
import {
  endpointAddress,
  readActiveGraphId,
  workspacePaths,
} from "@lukawi/toporealm-daemon-core";
import { serveDaemon } from "../server.js";
import { resolveWebUiDist } from "@lukawi/toporealm-web";
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
  let webPort: number | undefined;
  let noWeb = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i] ?? root;
    else if (a === "--graph") graph = argv[++i];
    else if (a === "--idle-ms") idleMs = Number(argv[++i]);
    else if (a === "--web-port") webPort = Number(argv[++i]);
    else if (a === "--no-web") noWeb = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: toporeald [--root <dir>] [--graph <id>] [--idle-ms <ms>] [--web-port <p>] [--no-web]\n" +
          "  --root      工作区目录（默认 cwd）\n" +
          "  --graph     服务哪张图（默认 .toporealm/active）\n" +
          "  --idle-ms   空闲退出毫秒；0 = 永不（默认 TOPOREALM_IDLE_MS 或 30000）\n" +
          "  --web-port  web 伺服端口（默认 TOPOREALM_WEB_PORT 或 0=临时口；D22）\n" +
          "  --no-web    关闭 web 伺服（HTTP 静态 + /ws）\n",
      );
      return 0;
    }
  }
  root = path.resolve(root);
  if (idleMs === undefined || Number.isNaN(idleMs)) {
    const env = Number(process.env.TOPOREALM_IDLE_MS);
    idleMs = Number.isFinite(env) ? env : 30_000;
  }
  if (webPort === undefined || Number.isNaN(webPort)) {
    const env = Number(process.env.TOPOREALM_WEB_PORT);
    webPort = Number.isFinite(env) ? env : 0;
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
  const staticDir = noWeb ? undefined : (resolveWebUiDist() ?? undefined);
  try {
    running = await serveDaemon({
      root,
      graph,
      idleMs,
      ...(noWeb
        ? { web: false }
        : { web: { port: webPort, ...(staticDir !== undefined ? { staticDir } : {}) } }),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || code === "EACCES") {
      process.stderr.write(
        `toporeald: IPC endpoint 监听失败（被占用或无权限，可能有并存 daemon）：${endpointAddress(root).address}\n`,
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
    ...(running.web !== null
      ? { webPort: running.web.port, webStatic: staticDir !== undefined }
      : {}),
  });
  // D22 裁决②：web 端口被占回退临时口时如实记录（endpoint.webPort 已是实际端口）
  if (running.web?.fallbackFrom !== undefined) {
    process.stderr.write(
      `[toporeald] warning: web 端口 ${running.web.fallbackFrom} 被占，回退临时口 ${running.web.port}\n`,
    );
  }
  process.stderr.write(
    `[toporeald] graph "${running.graphId}" ready (pid ${process.pid}, cold ${running.loadMs.toFixed(1)}ms, idle ${idleMs}ms, modules ${running.modules.length}${running.modules.length > 0 ? `: ${running.modules.join(", ")}` : ""}${running.web !== null ? `, web ${running.web.url}` : ""})\n`,
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
