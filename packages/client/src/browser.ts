// 浏览器安全出口（零 node 依赖）：web-ui 经 "@lukawi/toporealm-client/browser"
// 引 WsClient——node:net/fs 等只在 "." 主出口（MemoryClient/IpcClient）里。
export { WsClient, WsSession, defaultWsUrl, type WsClientOptions, type WsReconnectOptions } from "./ws.js";
