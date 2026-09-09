import { describe, expect, it } from "vitest";
import { readWebAsset, renderWebShell, webSurface } from "../src/web/index.js";

describe("TopoRealm Web shell", () => {
  it("保留稳定 Web surface，并在没有构建资源时提供可读 fallback", () => {
    expect(webSurface.coreFormat).toBe("toporealm.graph/v1");
    expect(renderWebShell()).toContain("TopoRealm");
    expect(renderWebShell()).toContain("id=\"app\"");
    expect(renderWebShell("D:/path/that/does/not/exist")).toContain("refresh");
  });

  it("拒绝从静态资源根目录逃逸的路径", () => {
    expect(readWebAsset("/../package.json", "D:/path/that/does/not/exist")).toBeUndefined();
  });
});
