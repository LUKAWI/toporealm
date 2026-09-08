import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installModule, uninstallModule } from "../src/distribution/installer.js";
import { syncHosts } from "../src/distribution/hosts.js";
import { WorkspaceModuleResolver } from "../src/module-sdk/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempPackage(): { base: string; workspace: string; packageRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "toporealm-m5-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  const packageRoot = join(base, "package");
  mkdirSync(workspace, { recursive: true });
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/modules/exploration");
  cpSync(source, packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@toporealm/exploration", version: "0.1.0", type: "module", toporealm: "./module.yaml", files: ["module.yaml", "schemas", "operations", "ui"] }, null, 2), "utf8");
  return { base, workspace, packageRoot };
}

describe("module distribution", () => {
  it("使用 npm pack --ignore-scripts 解包自包含模块、写绑定并可安全卸载", () => {
    const { workspace, packageRoot } = tempPackage();
    const installed = installModule(packageRoot, { workspaceRoot: workspace });
    expect(installed.id).toBe("exploration");
    const updated = installModule(packageRoot, { workspaceRoot: workspace });
    expect(updated.version).toBe("0.1.0");
    expect(existsSync(join(workspace, ".toporealm", "modules", "exploration", "module.yaml"))).toBe(true);
    expect(readFileSync(join(workspace, ".toporealm", "modules.yaml"), "utf8")).toContain("exploration");
    expect(new WorkspaceModuleResolver(workspace).resolve("exploration").status).toBe("available");
    uninstallModule("exploration", { workspaceRoot: workspace });
    expect(existsSync(join(workspace, ".toporealm", "modules", "exploration"))).toBe(false);
  });

  it("按工作区绑定生成 Codex、Claude、Pi 投影，并保护无归属目录", () => {
    const { base, workspace } = tempPackage();
    const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/workflow-slice");
    cpSync(fixture, workspace, { recursive: true });
    cpSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/modules"), join(base, "modules"), { recursive: true });
    const results = syncHosts({
      workspaceRoot: workspace,
      hostRoots: { codex: join(base, "codex"), claude: join(base, "claude"), pi: join(base, "pi") },
    });
    expect(results.map((result) => result.host)).toEqual(["codex", "claude", "pi"]);
    expect(existsSync(join(base, "codex", ".toporealm", "generated", "codex", ".codex-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(base, "claude", ".toporealm", "generated", "claude", ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(base, "pi", ".toporealm", "generated", "pi", "index.js"))).toBe(true);
    const workflowSkill = join(base, "codex", ".toporealm", "generated", "codex", "skills", "workflow");
    rmSync(join(workflowSkill, ".toporealm-owner.json"));
    expect(() => syncHosts({ workspaceRoot: workspace, hostRoots: { codex: join(base, "codex"), claude: join(base, "claude"), pi: join(base, "pi") } })).toThrow(/不会覆盖/);
  });
});
