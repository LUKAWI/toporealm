// 生命周期发现面的复出口：cli（serve 动词）经 client 使用，不直接依赖 daemon-core
// （依赖单向：protocol ← client ← cli/web-ui）。
export {
  clearEndpoint,
  isPidAlive,
  readEndpoint,
  waitForPidExit,
  type DaemonEndpointInfo,
} from "@lukawi/toporealm-daemon-core";
