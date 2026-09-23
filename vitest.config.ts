import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // IPC 生命周期用例（spawn daemon、空闲退出、外部编辑监视）在 Windows 上需要宽裕的时间
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
