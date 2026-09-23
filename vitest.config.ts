import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  test: {
    // 单一门禁覆盖全部测试（blueprint §8）：packages 后端缝 + web-ui 浏览器层
    projects: [
      {
        test: {
          name: "packages",
          include: ["packages/*/test/**/*.test.ts"],
          // IPC 生命周期用例（spawn daemon、空闲退出、外部编辑监视）在 Windows 上需要宽裕的时间
          testTimeout: 20000,
          hookTimeout: 20000,
          // 文件串行：冷启动 <100ms 等计时断言不与 jsdom 环境装配抢 CPU
          fileParallelism: false,
        },
      },
      {
        plugins: [svelte()],
        resolve: { conditions: ["browser"] }, // svelte 客户端构建（mount 可用）
        test: {
          name: "web-ui",
          include: ["web-ui/src/**/*.test.ts"],
          environment: "jsdom",
          testTimeout: 20000,
          hookTimeout: 20000,
        },
      },
    ],
  },
});
