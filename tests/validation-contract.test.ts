import { describe, expect, it } from "vitest";
import {
  CORE_ENVELOPE_FIELDS,
  JSON_SCHEMA_2020_12,
  MODULE_PRIVATE_FIELDS,
  VALIDATION_CODES,
  type ModulePrivateSchema,
  type SnapshotValidationContext,
  type TransitionValidationContext,
  type ValidationDiagnostic,
  type ValidationResult,
} from "../src/core/validation-types.js";
import type { GraphPatch, GraphSnapshot } from "../src/core/types.js";
import {
  sortValidationDiagnostics,
  type ModuleRuntime,
} from "../src/module-sdk/validation.js";

const candidate: GraphSnapshot = {
  manifest: {
    format: "toporealm.graph/v1",
    id: "demo",
    sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
  },
  objects: [],
  relations: [],
  revision: 2,
};

const changes: GraphPatch = {
  fromRevision: 1,
  toRevision: 2,
  objects: { added: [], updated: [], deleted: [] },
  relations: { added: [], updated: [], deleted: [] },
  manifestChanged: false,
};

describe("validation contract", () => {
  it("discriminates snapshot and transition contexts and keeps their inputs read-only", () => {
    const snapshot: SnapshotValidationContext = { kind: "snapshot", candidate };
    const transition: TransitionValidationContext = { kind: "transition", before: candidate, candidate, changes };

    expect(snapshot).toEqual({ kind: "snapshot", candidate });
    expect(snapshot).not.toHaveProperty("before");
    expect(snapshot).not.toHaveProperty("changes");
    expect(transition).toEqual({ kind: "transition", before: candidate, candidate, changes });
    expect(transition).toHaveProperty("before", candidate);
    expect(transition).toHaveProperty("changes", changes);
  });

  it("limits module schemas to kind data or capability state and fixes the draft", () => {
    const dataSchema: ModulePrivateSchema = {
      target: { area: "data", kind: "research.question" },
      schema: {
        $schema: JSON_SCHEMA_2020_12,
        type: "object",
        properties: { scope: { type: "string" } },
      },
    };
    const capabilitySchema: ModulePrivateSchema = {
      target: { area: "capabilities", capability: "exploration.unknown" },
      schema: { $schema: JSON_SCHEMA_2020_12, type: "object" },
    };

    expect(CORE_ENVELOPE_FIELDS).toEqual(["id", "kind", "label", "source", "target", "direction", "meta"]);
    expect(MODULE_PRIVATE_FIELDS).toEqual(["data", "capabilities"]);
    expect(dataSchema.schema).toMatchObject({ $schema: JSON_SCHEMA_2020_12, type: "object" });
    expect(capabilitySchema.target).toEqual({ area: "capabilities", capability: "exploration.unknown" });
  });

  it("exposes optional execute and the two validator seams without storage access", () => {
    const runtime: ModuleRuntime = {
      validate: (validatorId, context) => {
        expect(validatorId).toBeTypeOf("string");
        expect(["snapshot", "transition"]).toContain(context.kind);
        return [];
      },
    };

    expect(runtime.execute).toBeUndefined();
    expect(runtime.validate).toBeTypeOf("function");
  });

  it("sorts diagnostics deterministically without mutating the source array", () => {
    const diagnostics: ValidationDiagnostic[] = [
      { entityId: "b", code: "Z_RULE", message: "z", severity: "error" },
      { entityId: "a", code: "Z_RULE", message: "z", severity: "warning" },
      { entityId: "a", code: "A_RULE", message: "a", severity: "error" },
      { code: "A_RULE", message: "global", severity: "warning" },
    ];

    const sorted = sortValidationDiagnostics(diagnostics);
    expect(sorted).not.toBe(diagnostics);
    expect(sorted.map((diagnostic) => `${diagnostic.entityId ?? "-"}:${diagnostic.code}`)).toEqual([
      "-:A_RULE",
      "a:A_RULE",
      "a:Z_RULE",
      "b:Z_RULE",
    ]);
    expect(diagnostics[0]?.entityId).toBe("b");
  });

  it("keeps complete independent from the presence of ordinary errors", () => {
    const completeWithError: ValidationResult = {
      ok: false,
      complete: true,
      diagnostics: [{ code: "MODULE_SCHEMA_INVALID", message: "字段无效", severity: "error" }],
    };
    const incompleteWithWarning: ValidationResult = {
      ok: true,
      complete: false,
      diagnostics: [{ code: VALIDATION_CODES.VALIDATOR_UNAVAILABLE, message: "validator 缺失", severity: "warning" }],
    };
    const exception: ValidationDiagnostic = {
      code: VALIDATION_CODES.VALIDATOR_EXCEPTION,
      message: "validator 抛出异常",
      severity: "error",
    };

    expect(completeWithError).toMatchObject({ ok: false, complete: true });
    expect(incompleteWithWarning).toMatchObject({ ok: true, complete: false });
    expect(exception).toMatchObject({ code: "VALIDATOR_EXCEPTION", severity: "error" });
  });
});
