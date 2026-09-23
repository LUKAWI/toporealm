import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  IpcClient,
  activateGraph,
  clearEndpoint,
  isPidAlive,
  listGraphs,
  provisionGraph,
  readEndpoint,
  resolveTarget,
  spawnDaemonDetached,
} from "@lukawi/toporealm-client";
import {
  TopoError,
  isRelation,
  isValidGraphId,
  suggestClosest,
  type Catalog,
  type Change,
  type DaemonClient,
  type EntityRecord,
  type GraphSummary,
  type ReadQuery,
  type Session,
} from "@lukawi/toporealm-protocol";
import {
  hostSync,
  installModule,
  listModules,
  migrateGraph,
  removeModule,
  type HostId,
} from "@lukawi/toporealm-distribution";
import {
  Argv,
  CORE_VERBS,
  UsageError,
  helpText,
  parseFields,
  parseJsonObject,
  parseKvPairs,
  unknownVerbSuggestion,
} from "./usage.js";

// ---------- toporealm CLI：人与 agent 的共同入口（blueprint §4） ----------
// 信封：--json 成功 {ok:true,data,revision?,instanceId}；失败 stderr {ok:false,error}
// 退出码：0 成功 · 1 领域错误 · 2 用法错误（本地解析，不触 daemon）

export interface CliDeps {
  /** 测试注入（golden 信封用 MemoryClient 后端，blueprint §8） */
  clientFactory?: () => DaemonClient;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** serve 动词注入：覆盖 daemon 启动命令（测试） */
  daemonCommand?: { cmd: string; args: string[] };
  /** serve 动词注入：打开浏览器（测试断言 URL） */
  openBrowser?: (url: string) => void;
}

/** 系统默认浏览器打开 URL（serve 默认实现；失败由调用方兜底） */
function openInBrowser(url: string): void {
  const plat = process.platform;
  const child =
    plat === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
      : plat === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

interface Globals {
  json: boolean;
  root?: string;
  graph?: string;
  rest: string[];
}

function extractGlobals(argv: string[], env: NodeJS.ProcessEnv): Globals {
  const rest = [...argv];
  const json = rest.includes("--json");
  if (json) rest.splice(rest.indexOf("--json"), 1);
  let root: string | undefined;
  let graph: string | undefined;
  for (;;) {
    const ri = rest.indexOf("--root");
    if (ri >= 0) {
      root = (rest[ri + 1] as string) ?? undefined;
      rest.splice(ri, 2);
      continue;
    }
    const gi = rest.indexOf("--graph");
    if (gi >= 0) {
      graph = (rest[gi + 1] as string) ?? undefined;
      rest.splice(gi, 2);
      continue;
    }
    break;
  }
  return {
    json,
    root: root ?? env.TOPOREALM_ROOT ?? undefined,
    graph: graph ?? env.TOPOREALM_GRAPH ?? undefined,
    rest,
  };
}

function defaultRoot(deps: CliDeps): string {
  return path.resolve(deps.cwd ?? process.cwd());
}

/** 目录拉取（help 动态聚合用）：触达不了 daemon（无工作区/图）→ null，回退纯静态帮助 */
async function fetchCatalog(
  deps: CliDeps,
  root: string,
  graph?: string,
): Promise<Catalog | null> {
  try {
    const client = deps.clientFactory?.() ?? new IpcClient();
    const s = await client.connect({
      root,
      ...(graph !== undefined ? { graph } : {}),
    });
    try {
      return await s.catalog();
    } finally {
      await s.close();
    }
  } catch {
    return null;
  }
}

interface VerbOutcome {
  envelope: Record<string, unknown>;
  human: string;
}

function okEnvelope(
  data: unknown,
  extra: { revision?: number; instanceId?: string } = {},
): Record<string, unknown> {
  const e: Record<string, unknown> = { ok: true, data };
  if (extra.revision !== undefined) e.revision = extra.revision;
  if (extra.instanceId !== undefined) e.instanceId = extra.instanceId;
  return e;
}

async function withSession(
  deps: CliDeps,
  root: string,
  graph: string | undefined,
  fn: (s: Session) => Promise<{ data: unknown; human: string; revision?: number }>,
): Promise<VerbOutcome> {
  const client = deps.clientFactory?.() ?? new IpcClient();
  const s = await client.connect({
    root,
    ...(graph !== undefined ? { graph } : {}),
  });
  try {
    const r = await fn(s);
    return {
      envelope: okEnvelope(r.data, {
        ...(r.revision !== undefined ? { revision: r.revision } : {}),
        instanceId: s.instanceId,
      }),
      human: r.human,
    };
  } finally {
    await s.close();
  }
}

// ---------- 人类可读输出 ----------

function humanSummary(s: GraphSummary): string {
  const counts =
    Object.entries(s.counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ") || "(empty)";
  return (
    `${s.graphId} @ rev ${s.revision} · ${counts}\n` +
    `  undo ${s.canUndo ? "✓" : "✗"} · redo ${s.canRedo ? "✓" : "✗"} · modules ${s.modules.length}`
  );
}

function humanEntities(entities: readonly EntityRecord[]): string {
  if (entities.length === 0) return "  (0 entities)";
  return entities
    .map((e) => {
      // 投影后的实体可能没有 payload
      const title =
        typeof e.payload?.["title"] === "string"
          ? ` ${e.payload["title"] as string}`
          : "";
      if (isRelation(e)) {
        return `  ${e.id} [${e.kind}] ${e.source} -> ${e.target}${title}`;
      }
      return `  ${e.id} [${e.kind}]${title}`;
    })
    .join("\n");
}

// ---------- 动词分发 ----------

async function dispatch(
  g: Globals,
  deps: CliDeps,
): Promise<VerbOutcome> {
  const verb = g.rest[0] as string | undefined;
  const args = g.rest.slice(1);
  const env = deps.env ?? {};

  if (verb === undefined || verb === "help") {
    // help [cmd]：core 静态表 + 目录动态聚合（单一真相，blueprint §4）
    const helpTarget = g.rest[1];
    const root = g.root ?? defaultRoot(deps);
    const cat = helpTarget === "version" ? null : await fetchCatalog(deps, root, g.graph);
    const commands = cat?.commands ?? [];
    const entry =
      helpTarget !== undefined && helpTarget.includes(".")
        ? commands.find((c) => c.id === helpTarget)
        : undefined;
    if (entry) {
      const lines = [
        `${entry.id} — ${entry.title}`,
        `  module: ${entry.module}`,
        ...(entry.target !== undefined ? [`  appliesTo: ${entry.target}`] : []),
        ...(entry.input !== undefined
          ? [`  input schema: ${JSON.stringify(entry.input)}`]
          : []),
        `  用法：toporealm ${entry.id}${entry.target !== undefined ? " <target>" : ""} [--input '<json>']`,
      ];
      return { envelope: { ok: true, data: entry }, human: lines.join("\n") };
    }
    return {
      envelope: { ok: true, data: { verbs: CORE_VERBS, commands } },
      human: helpText(commands),
    };
  }
  if (verb === "version") {
    const req = createRequire(import.meta.url);
    const pkg = JSON.parse(
      fs.readFileSync(req.resolve("@lukawi/toporealm-cli/package.json"), "utf8"),
    ) as { version: string };
    return {
      envelope: { ok: true, data: { version: pkg.version } },
      human: `toporealm ${pkg.version} (contract toporealm.graph/v2)`,
    };
  }
  // ★模块命令即顶层子命令（点号与核心动词零冲突，blueprint §4）：<ns.name> [target] [--input '<json>']
  if (verb.includes(".")) {
    const a = new Argv(args);
    // 先吃 flag，再取位置参数（否则 flag 值会被误当 target id）
    const input = parseJsonObject(a.value("--input"), "--input");
    const target = a.positionals()[0];
    const root = g.root ?? defaultRoot(deps);
    return withSession(deps, root, g.graph, async (s) => {
      const r = await s.run(verb, {
        ...(target !== undefined ? { target } : {}),
        ...(input !== undefined ? { input } : {}),
      });
      const lastRev = r.commits?.at(-1)?.revision;
      return {
        data: r,
        human: `${r.message ?? `ok ${verb}`}${lastRev !== undefined ? ` (revision ${lastRev})` : ""}`,
        ...(lastRev !== undefined ? { revision: lastRev } : {}),
      };
    });
  }
  if (!verb.includes("-")) {
    // 未知核心动词 → 用法错误（did-you-mean）
    if (!(CORE_VERBS as readonly string[]).includes(verb)) {
      throw new UsageError(
        `未知命令 "${verb}"${unknownVerbSuggestion(verb)}`,
        "toporealm help",
      );
    }
  }

  switch (verb) {
    // ---- 图生命周期（工作区文件操作，不进 daemon 缝） ----
    case "new": {
      const a = new Argv(args);
      const name = a.positionals()[0];
      if (!name) throw new UsageError("用法：toporealm new <graph> [--label L]");
      if (!isValidGraphId(name)) {
        throw new UsageError(
          `图 id 非法："${name}"（将用作目录名，禁 / \\ : 空格与控制字符）`,
        );
      }
      const label = a.value("--label");
      const root = g.root ?? defaultRoot(deps);
      await provisionGraph(root, name, label);
      return {
        envelope: { ok: true, data: { graph: name } },
        human: `created graph "${name}" — selected`,
      };
    }
    case "use": {
      const a = new Argv(args);
      const name = a.positionals()[0];
      if (!name) throw new UsageError("用法：toporealm use <graph>");
      if (!isValidGraphId(name)) throw new UsageError(`图 id 非法："${name}"`);
      const root = g.root ?? defaultRoot(deps);
      await activateGraph(root, name);
      return {
        envelope: { ok: true, data: { graph: name } },
        human: `switched to graph "${name}"`,
      };
    }
    case "graphs": {
      const root = g.root ?? defaultRoot(deps);
      let current: string | undefined;
      try {
        current = (
          await resolveTarget({
            root,
            ...(g.graph !== undefined ? { graph: g.graph } : {}),
            env,
          })
        ).graphId;
      } catch {
        current = undefined;
      }
      const graphs = await listGraphs(root, current);
      return {
        envelope: { ok: true, data: { graphs } },
        human:
          graphs.map(
            (e) =>
              `${e.current ? "* " : "  "}${e.id}${e.label !== undefined ? ` — ${e.label}` : ""} (rev ${e.revision})`,
          ).join("\n") || "  (no graphs)",
      };
    }

    // ---- 图事实面（经单属主 daemon） ----
    case "status": {
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const st = await s.status();
        return { data: st, human: humanSummary(st), revision: st.revision };
      });
    }
    case "read": {
      const a = new Argv(args);
      // 先吃 flag，再取位置参数（否则 flag 会被误当实体 id）
      const kinds = a.values("--kind");
      const wheres = a.values("--where");
      const fields = parseFields(a.values("--fields"));
      const limit = a.numberValue("--limit");
      const pos = a.positionals();
      const id = pos[0];
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        if (id !== undefined) {
          // 单点邻域：实体 + 触达它的关系
          const res = await s.read({ ids: [id] });
          if (res.entities.length === 0) {
            const all = await s.read({ fields: ["id"] });
            const candidates = all.entities.map((e) => e.id);
            const suggestions = suggestClosest(id, candidates);
            throw new TopoError({
              code: "UNKNOWN_ID",
              message: `实体不存在："${id}"`,
              hint:
                suggestions.length > 0
                  ? `是不是想用 "${suggestions[0] as string}"？`
                  : "用 toporealm find 查现存实体",
              details: { id, suggestions },
            });
          }
          const entity = res.entities[0] as EntityRecord;
          const allRels = await s.read();
          const relations = allRels.entities
            .filter(isRelation)
            .filter((r) => r.source === id || r.target === id);
          return {
            data: { entity, relations },
            human: humanEntities([entity]) + `\n  · ${relations.length} relation(s)`,
            revision: res.revision,
          };
        }
        const query: ReadQuery = {};
        if (kinds.length > 0) query.kinds = kinds;
        if (wheres.length > 0) {
          query.where = wheres.map((w) => {
            const eq = parseKvPairs([w]);
            const [k, v] = Object.entries(eq)[0] as [string, unknown];
            return { eq: { [k]: v } };
          });
        }
        if (fields.length > 0) query.fields = fields as ReadQuery["fields"];
        const res = await s.read(query);
        const entities =
          limit !== undefined ? res.entities.slice(0, limit) : res.entities;
        return {
          data: { revision: res.revision, entities },
          human: `${entities.length} entity(ies) @ rev ${res.revision}\n${humanEntities(entities)}`,
          revision: res.revision,
        };
      });
    }
    case "find": {
      const a = new Argv(args);
      const kinds = a.values("--kind");
      const fields = parseFields(a.values("--fields"));
      const kvArgs = a.positionals();
      if (kvArgs.length === 0) {
        throw new UsageError("用法：toporealm find <k=v>... [--kind K] [--fields f]");
      }
      const eq = parseKvPairs(kvArgs);
      const where = [
        ...kinds.map((kind) => ({ kind, eq })),
        ...(kinds.length > 0 ? [] : [{ eq }]),
      ];
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const res = await s.read({
          where,
          ...(fields.length > 0 ? { fields: fields as ReadQuery["fields"] } : {}),
        });
        return {
          data: { revision: res.revision, entities: res.entities },
          human: `${res.entities.length} hit(s) @ rev ${res.revision}\n${humanEntities(res.entities)}`,
          revision: res.revision,
        };
      });
    }
    case "add": {
      const a = new Argv(args);
      const id = a.value("--id");
      const payload = parseJsonObject(a.value("--payload"), "--payload") ?? {};
      const kind = a.positionals()[0];
      if (!kind) {
        throw new UsageError("用法：toporealm add <kind> [--id X] [--payload '<json>']");
      }
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const r = await s.commit({
          changes: [
            { op: "put", kind, ...(id !== undefined ? { id } : {}), payload },
          ],
          label: `add ${kind}`,
        });
        const createdId = r.created[0] ?? id ?? "";
        return {
          data: { id: createdId, created: r.created },
          human: `created ${createdId} (revision ${r.revision})`,
          revision: r.revision,
        };
      });
    }
    case "set": {
      const a = new Argv(args);
      const replace = a.flag("--replace");
      const payloadJson = parseJsonObject(a.value("--payload"), "--payload");
      const pos = a.positionals();
      const id = pos[0];
      if (!id) {
        throw new UsageError(
          "用法：toporealm set <id> [k=v]... [--payload '<json>'] [--replace]",
        );
      }
      const kv = parseKvPairs(pos.slice(1));
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        let changes: Change[];
        if (replace) {
          const payload = { ...(payloadJson ?? {}), ...kv };
          if (Object.keys(payload).length === 0) {
            throw new UsageError(
              "--replace 需要提供完整载荷（k=v 或 --payload '<json>'）",
            );
          }
          changes = [{ op: "put", id, payload }];
        } else {
          const payload = { ...kv, ...(payloadJson ?? {}) };
          if (Object.keys(payload).length === 0) {
            throw new UsageError("set 需要至少一个 k=v 或 --payload '<json>'");
          }
          changes = [{ op: "merge", id, payload }];
        }
        const r = await s.commit({ changes, label: `set ${id}` });
        return {
          data: { id },
          human: `ok ${id} (revision ${r.revision})`,
          revision: r.revision,
        };
      });
    }
    case "link": {
      const a = new Argv(args);
      const kindFlag = a.value("--kind");
      const id = a.value("--id");
      const pos = a.positionals();
      const src = pos[0];
      const tgt = pos[1];
      if (!src || !tgt) {
        throw new UsageError("用法：toporealm link <src> <tgt> [--kind ns.rel] [--id X]");
      }
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        let kind = kindFlag;
        if (kind === undefined) {
          // 仅一种关系类型时可省 --kind（story 10）
          const all = await s.read();
          const relKinds = [
            ...new Set(all.entities.filter(isRelation).map((r) => r.kind)),
          ];
          if (relKinds.length === 1) kind = relKinds[0] as string;
          else if (relKinds.length === 0) {
            throw new UsageError(
              "图中尚无关系类型；请用 --kind 指定（如 --kind ns.rel）",
            );
          } else {
            throw new UsageError(
              `图中存在多种关系类型（${relKinds.join(", ")}）；请用 --kind 指定`,
            );
          }
        }
        const r = await s.commit({
          changes: [
            {
              op: "rel",
              kind,
              ...(id !== undefined ? { id } : {}),
              source: src,
              target: tgt,
            },
          ],
          label: `link ${src}->${tgt}`,
        });
        const relId = r.created[0] ?? id ?? "";
        return {
          data: { id: relId },
          human: `linked ${relId} (${kind}: ${src} -> ${tgt}, revision ${r.revision})`,
          revision: r.revision,
        };
      });
    }
    case "rm": {
      const a = new Argv(args);
      const id = a.positionals()[0];
      if (!id) throw new UsageError("用法：toporealm rm <id>");
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const r = await s.commit({ changes: [{ op: "del", id }], label: `rm ${id}` });
        return {
          data: { id },
          human: `deleted ${id} (revision ${r.revision})`,
          revision: r.revision,
        };
      });
    }
    case "log": {
      const a = new Argv(args);
      const n = a.numberValue("-n") ?? 20;
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const entries = await s.log({ limit: n });
        const st = await s.status();
        const rows = entries
          .map(
            (e) =>
              `  ${e.revision}\t${e.kind}\t${e.origin}${e.label !== undefined ? `\t${e.label}` : ""}\t${e.time}`,
          )
          .join("\n");
        return {
          data: { entries },
          human: `${entries.length} entr(ies):\n${rows || "  (empty)"}`,
          revision: st.revision,
        };
      });
    }
    case "cmds": {
      const a = new Argv(args);
      const mod = a.value("--module");
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const cat = await s.catalog(mod);
        const modules =
          cat.modules.length > 0
            ? cat.modules
                .map((m) => `  ${m.id} @ ${m.version} (ns: ${m.namespace})`)
                .join("\n")
            : "  (no modules)";
        const cmds =
          cat.commands.length > 0
            ? cat.commands
                .map(
                  (c) =>
                    `  ${c.id}${c.target !== undefined ? ` [target: ${c.target}]` : ""}    ${c.title}`,
                )
                .join("\n")
            : "  (no commands)";
        return {
          data: cat,
          human: `${cat.modules.length} module(s):\n${modules}\n${cat.commands.length} command(s):\n${cmds}`,
        };
      });
    }
    case "serve": {
      // serve [--port P] [--no-open]（blueprint §4 + D22）：确保带 web 伺服的 daemon
      // 在跑（必要时自动拉起 detached toporeald）→ 打开浏览器即退；daemon 常驻服务。
      const a = new Argv(args);
      const port = a.numberValue("--port");
      const noOpen = a.flag("--no-open");
      const root = g.root ?? defaultRoot(deps);
      const target = await resolveTarget({
        root,
        ...(g.graph !== undefined ? { graph: g.graph } : {}),
        env,
      });
      const open = deps.openBrowser ?? openInBrowser;
      const announce = (ep: { webPort: number; pid: number; graphId: string }): VerbOutcome => {
        const url = `http://127.0.0.1:${ep.webPort}`;
        if (!noOpen) {
          try {
            open(url);
          } catch (err) {
            // 打开浏览器失败不作为命令失败（服务器本身已就绪）
            void err;
          }
        }
        return {
          envelope: { ok: true, data: { url, port: ep.webPort, pid: ep.pid, graphId: ep.graphId } },
          human: `WebUI: ${url}（daemon pid ${ep.pid}，图 "${ep.graphId}"；Ctrl+C 无关紧要——daemon 常驻，toporeald 负责生命周期）`,
        };
      };
      const ep0 = await readEndpoint(root);
      if (ep0 !== null && isPidAlive(ep0.pid)) {
        if (ep0.webPort === undefined) {
          throw new TopoError({
            code: "DAEMON_UNREACHABLE",
            message: "运行中的 daemon 未开启 web 伺服",
            hint: "老 daemon 不带 web；停止后重试 serve（客户端会自动拉起带 web 的新 daemon）",
          });
        }
        return announce({ webPort: ep0.webPort, pid: ep0.pid, graphId: ep0.graphId });
      }
      // 无 daemon（或陈旧 endpoint）：清掉重拉，拉起时传递端口诉求
      if (ep0 !== null) await clearEndpoint(root).catch(() => {});
      spawnDaemonDetached(
        { root: target.root, graphId: target.graphId },
        port !== undefined ? ["--web-port", String(port)] : [],
        deps.daemonCommand,
      );
      const deadline = Date.now() + 20_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 150));
        const ep = await readEndpoint(root).catch(() => null);
        if (ep !== null && ep.webPort !== undefined) {
          return announce({
            webPort: ep.webPort,
            pid: ep.pid,
            graphId: ep.graphId,
          });
        }
        if (Date.now() > deadline) {
          throw new TopoError({
            code: "DAEMON_UNREACHABLE",
            message: "daemon 拉起超时（endpoint 未就绪或未开启 web）",
            hint: "手动运行 toporeald --web-port <p> 观察输出",
          });
        }
      }
    }
    case "undo":
    case "redo": {
      const a = new Argv(args);
      const pos = a.positionals()[0];
      let steps = 1;
      if (pos !== undefined) {
        steps = Number(pos);
        if (!Number.isInteger(steps) || steps < 1) {
          throw new UsageError(`${verb} 步数需要正整数，得到 "${pos}"`);
        }
      }
      const root = g.root ?? defaultRoot(deps);
      return withSession(deps, root, g.graph, async (s) => {
        const r =
          verb === "undo" ? await s.undo(steps) : await s.redo(steps);
        return {
          data: { revision: r.revision, canUndo: r.canUndo, canRedo: r.canRedo },
          human: `${verb === "undo" ? "undid" : "redid"} ${steps} step(s) → revision ${r.revision} (undo ${r.canUndo ? "✓" : "✗"} / redo ${r.canRedo ? "✓" : "✗"})`,
          revision: r.revision,
        };
      });
    }
    case "module": {
      // module add <npm|路径> | module rm <id> | module list（D23①：工作区冷路径安装）
      const sub = args[0];
      const a = new Argv(args.slice(1));
      const root = g.root ?? defaultRoot(deps);
      if (sub === "add") {
        const source = a.positionals()[0];
        if (!source) throw new UsageError("用法：toporealm module add <npm包|路径>");
        if (a.flag("--global")) {
          throw new UsageError(
            "--global 暂未支持（安装器只交付工作区安装，D23①）",
            "toporealm module add <npm包|路径>",
          );
        }
        const r = await installModule({ root, source });
        const origin = r.origin.type === "npm" ? `npm:${r.origin.spec}` : `path:${r.origin.path}`;
        return {
          envelope: { ok: true, data: r },
          human: `installed ${r.id} @ ${r.version} (${origin})\n  → ${r.dir}\n  ${r.note}`,
        };
      }
      if (sub === "rm") {
        const id = a.positionals()[0];
        if (!id) throw new UsageError("用法：toporealm module rm <id>");
        const r = await removeModule({ root, id });
        return {
          envelope: { ok: true, data: r },
          human: `removed ${r.id}\n  ${r.note}`,
        };
      }
      if (sub === "list") {
        const rows = await listModules(root);
        const human =
          rows
            .map((m) => {
              const origin =
                m.origin !== undefined
                  ? m.origin.type === "npm"
                    ? `npm:${m.origin.spec}`
                    : `path:${m.origin.path}`
                  : undefined;
              return `  ${m.id}\t${m.source}${m.version !== undefined ? `\t${m.version}` : ""}${
                m.namespace !== undefined ? `\t(ns: ${m.namespace})` : ""
              }${origin !== undefined ? `\t← ${origin}` : ""}`;
            })
            .join("\n") || "  (no modules)";
        return {
          envelope: { ok: true, data: { modules: rows } },
          human: `${rows.length} module(s):\n${human}`,
        };
      }
      throw new UsageError(
        `未知 module 子命令 "${sub ?? ""}"（合法：add | rm | list）`,
        "toporealm help module",
      );
    }
    case "migrate": {
      const a = new Argv(args);
      const dryRun = a.flag("--dry-run");
      const oldDir = a.positionals()[0];
      if (!oldDir) throw new UsageError("用法：toporealm migrate <旧图目录> [--dry-run]");
      const root = g.root ?? defaultRoot(deps);
      const report = await migrateGraph({ root, oldDir, ...(dryRun ? { dryRun: true } : {}) });
      const conflicts = report.conflicts.length;
      const problems = report.errors.length + report.dangling.length;
      const human =
        (report.dryRun ? "[dry-run] " : "") +
        `migrated "${report.graph.id}" → ${report.target}\n` +
        `  revision ${report.graph.revision}（undo 游标清零；历史不迁移）· objects ${report.objects.migrated} · relations ${report.relations.migrated}` +
        (report.objects.skipped + report.relations.skipped > 0
          ? ` · skipped ${report.objects.skipped + report.relations.skipped}`
          : "") +
        `\n  conflicts ${conflicts} · degradations ${report.degradations.length} · dangling ${report.dangling.length} · errors ${report.errors.length}` +
        (problems + conflicts > 0
          ? `\n  （明细见 --json 信封：error.conflicts/degradations/dangling/errors）`
          : "");
      return { envelope: { ok: true, data: report }, human };
    }
    case "host": {
      const sub = args[0];
      if (sub !== "sync") {
        throw new UsageError(`未知 host 子命令 "${sub ?? ""}"（合法：sync）`, "toporealm help host");
      }
      const a = new Argv(args.slice(1));
      const hostFlag = a.value("--host");
      let hosts: HostId[] | undefined;
      if (hostFlag !== undefined && hostFlag !== "all") {
        if (hostFlag !== "claude-code" && hostFlag !== "pi") {
          throw new UsageError(`--host 非法："${hostFlag}"（合法：claude-code | pi | all）`);
        }
        hosts = [hostFlag];
      }
      const root = g.root ?? defaultRoot(deps);
      const r = await hostSync({ root, ...(hosts !== undefined ? { hosts } : {}) });
      return {
        envelope: { ok: true, data: r },
        human:
          `host sync（${r.modules.length} module(s) 投影）\n` +
          r.hosts
            .map((h) => `  ${h.host}: ${h.dir}\n    ${h.files.map((f) => `${f}`).join("\n    ")}`)
            .join("\n") +
          (r.warnings.length > 0 ? `\n  warning: ${r.warnings.join("；")}` : ""),
      };
    }
    default:
      throw new UsageError(
        `未知命令 "${verb}"${unknownVerbSuggestion(verb)}`,
        "toporealm help",
      );
  }
}

/** CLI 入口：返回退出码（0/1/2） */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? (() => {});
  const err = deps.err ?? (() => {});
  const env = deps.env ?? {};
  const g = extractGlobals(argv, env);
  try {
    const result = await dispatch(g, deps);
    if (g.json) out(JSON.stringify(result.envelope) + "\n");
    else out(result.human.endsWith("\n") ? result.human : result.human + "\n");
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      const errorPayload = {
        code: "INVALID_INPUT",
        message: e.message,
        ...(e.fix !== undefined ? { fix: e.fix } : {}),
      };
      if (g.json) {
        err(JSON.stringify({ ok: false, error: errorPayload }) + "\n");
      } else {
        err(`toporealm: ${e.message}\n`);
        if (e.fix !== undefined) err(`  fix: ${e.fix}\n`);
      }
      return 2;
    }
    const topo = TopoError.is(e)
      ? e
      : new TopoError({
          code: "DAEMON_UNREACHABLE",
          message: e instanceof Error ? e.message : String(e),
        });
    if (g.json) {
      err(JSON.stringify({ ok: false, error: topo.toJSON() }) + "\n");
    } else {
      err(`toporealm: [${topo.code}] ${topo.message}\n`);
      if (topo.hint !== undefined) err(`  hint: ${topo.hint}\n`);
      if (topo.fix !== undefined) err(`  fix: ${topo.fix}\n`);
    }
    return 1;
  }
}
