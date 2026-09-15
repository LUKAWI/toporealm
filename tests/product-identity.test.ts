import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../src/product-identity.js";
import { runCli } from "../src/cli/index.js";

describe("Product Identity", () => {
  it("从包根 manifest 派生包、版本、channel、CLI 与 MCP 身份", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string; publishConfig: { tag: string }; bin: Record<string, string> };
    expect(PRODUCT_IDENTITY).toEqual({
      packageName: manifest.name,
      version: manifest.version,
      channel: manifest.publishConfig.tag,
      cliName: Object.keys(manifest.bin)[0],
      mcpServerName: Object.keys(manifest.bin)[0],
    });
    expect(runCli(["version"])).toBe(manifest.version);
    expect(runCli(["help"])).toContain(manifest.version);
  });
});
