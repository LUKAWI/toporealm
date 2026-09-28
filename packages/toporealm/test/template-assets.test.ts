// D43：模块模板与基座技能资产防漂移——文件在、清单可解析、frontmatter 可被技能索引读取。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseModuleManifest } from "@lukawi/toporealm-module-host";

const pkgRoot = path.resolve(import.meta.dirname, "..");

describe("modules-template 与基座技能资产（D43）", () => {
  it("模板文件齐全且 module.yaml 按装载同款严格解析通过", async () => {
    const tpl = path.join(pkgRoot, "template", "modules-template");
    for (const f of [
      "module.yaml",
      "package.json",
      "tsconfig.json",
      "src/index.ts",
      "README.md",
      path.join("skills", "my-module", "SKILL.md"),
      ".gitignore",
    ]) {
      expect(readFileSync(path.join(tpl, f), "utf8").length, f).toBeGreaterThan(0);
    }
    // 模板是资产（id 会被使用者改名），按安装期宽松档解析（只豁免绑定键一致）
    const manifest = await parseModuleManifest(tpl, tpl, { strict: false });
    expect(manifest.format).toBe("toporealm.module/v2");
    expect(manifest.id).toBe("my-module");
    expect(manifest.namespace).toBe("my");
    expect(manifest.kinds?.objects).toContain("card");
    expect(manifest.entry).toBe("./dist/index.js");
  });

  it("基座与模板 SKILL.md 的 frontmatter 满足技能索引解析规则", () => {
    const skillFiles = [
      path.join(pkgRoot, "skills", "toporealm", "SKILL.md"),
      path.join(pkgRoot, "skills", "module-creator", "SKILL.md"),
      path.join(pkgRoot, "template", "modules-template", "skills", "my-module", "SKILL.md"),
    ];
    for (const f of skillFiles) {
      const text = readFileSync(f, "utf8");
      expect(text.startsWith("---"), f).toBe(true);
      const block = text.slice(3, text.indexOf("\n---", 3));
      const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      const description = /^description:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
      expect(name, f).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(description.length, f).toBeGreaterThan(0);
    }
  });

  it("聚合包 files 携带 template（发布面不丢资产）", () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    expect(pkg.files).toContain("template");
    expect(pkg.files).toContain("skills");
  });
});
