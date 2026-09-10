import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_SKILL_NAMES, routeSkillIntent, syncHosts } from "../src/distribution/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TopoRealm 基础 Skills", () => {
  it("把唯一正本完整投影到三个宿主", () => {
    const root = mkdtempSync(join(tmpdir(), "toporealm-skills-"));
    roots.push(root);
    const results = syncHosts({ workspaceRoot: root, hostRoots: { codex: join(root, "codex"), claude: join(root, "claude"), pi: join(root, "pi") } });
    expect(results).toHaveLength(3);
    for (const result of results) {
      for (const name of BASE_SKILL_NAMES) {
        const generated = readFileSync(join(result.projectionRoot, "skills", name, "SKILL.md"), "utf8");
        const canonical = readFileSync(join("integrations", "src", "skills", name, "SKILL.md"), "utf8");
        expect(generated).toBe(canonical);
      }
    }
  });

  it("明确请求直接路由，只有显式拷问或关键歧义进入 grilling", () => {
    expect(routeSkillIntent({})).toBe("toporealm");
    expect(routeSkillIntent({ designRequest: true })).toBe("toporealm-design");
    expect(routeSkillIntent({ joinRequest: true })).toBe("toporealm-join");
    expect(routeSkillIntent({ asksForGrilling: true })).toBe("toporealm-grilling");
    expect(routeSkillIntent({ criticalAmbiguity: true })).toBe("toporealm-grilling");
  });
});
