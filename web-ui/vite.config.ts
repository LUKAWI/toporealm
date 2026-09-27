import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// G1-7：dev 代理目标 = daemon 的 web 伺服端口。生产 WebUI 由 daemon 同源伺服（D22），
// dev 模式 vite 独立端口，不代理则 refreshGraphs/openPreview 的 /api/* 与 WsClient 的 /ws
// 都会静默失败（fetch 抛错被 store 吞掉、WS 连不上）。
// 端口来源与 daemon 一致读 TOPOREALM_WEB_PORT（toporeald --web-port 同款变量）；
// daemon 侧缺省 0=临时口，dev 联调建议固定端口启动：
//   export TOPOREALM_WEB_PORT=8787 && toporeald   （vite 同 shell 下自动取到 8787）
const daemonWebPort = Number(process.env.TOPOREALM_WEB_PORT) || 8787;

export default defineConfig({
  plugins: [svelte()],
  build: { outDir: "dist" },
  resolve: { conditions: ["browser"] },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${daemonWebPort}`,
      // daemon 同端口伺服 HTTP 静态 + /ws（web/server.ts），WebSocket 升级一并代理
      "/ws": { target: `ws://127.0.0.1:${daemonWebPort}`, ws: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
