// 生命周期发现面的复出口：cli（serve 动词）经 client 使用，不直接依赖 daemon-core
// （依赖单向：protocol ← client ← cli/web-ui）。本模块含 node 依赖，浏览器入口勿引。
import { TopoError } from "@lukawi/toporealm-protocol";
import { readEndpoint } from "@lukawi/toporealm-daemon-core";

export {
  clearEndpoint,
  isPidAlive,
  readEndpoint,
  waitForPidExit,
  type DaemonEndpointInfo,
} from "@lukawi/toporealm-daemon-core";

/** Node 缺省 WS URL：endpoint.webPort（D22 发现面）。浏览器同源场景用 ws.ts 的 defaultWsUrl。 */
export async function wsUrlFromEndpoint(root: string): Promise<string> {
  const ep = await readEndpoint(root);
  if (ep?.webPort === undefined) {
    throw new TopoError({
      code: "DAEMON_UNREACHABLE",
      message: "endpoint 中没有 web 伺服端口（webPort）——daemon 未运行或未开启 web",
      hint: "toporeald 默认开启 web；用 toporealm serve 或检查 endpoint.json",
    });
  }
  return `ws://127.0.0.1:${ep.webPort}/ws`;
}
