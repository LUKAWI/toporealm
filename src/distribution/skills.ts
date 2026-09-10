import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_SKILL_NAMES = ["toporealm", "toporealm-design", "toporealm-join", "toporealm-grilling"] as const;
export type BaseSkillName = typeof BASE_SKILL_NAMES[number];

export function baseSkillsRoot(): string {
  const packaged = fileURLToPath(new URL("../integrations/skills/", import.meta.url));
  return existsSync(join(packaged, "toporealm", "SKILL.md")) ? packaged : join(process.cwd(), "integrations", "src", "skills");
}

export function routeSkillIntent(input: {
  explicitSkill?: BaseSkillName;
  asksForGrilling?: boolean;
  criticalAmbiguity?: boolean;
  designRequest?: boolean;
  joinRequest?: boolean;
}): BaseSkillName {
  if (input.explicitSkill) return input.explicitSkill;
  if (input.asksForGrilling || input.criticalAmbiguity) return "toporealm-grilling";
  if (input.designRequest) return "toporealm-design";
  if (input.joinRequest) return "toporealm-join";
  return "toporealm";
}
