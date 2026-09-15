import { describe, expect, it } from "vitest";
import type { GraphSnapshot } from "../src/core/types.js";
import { JSON_SCHEMA_2020_12, VALIDATION_CODES, type ValidationContext } from "../src/core/validation-types.js";
import {
  compileModulePrivateSchema,
  loadModuleRuntime,
  normalizeModuleRuntime,
  runModuleValidator,
  type ModuleRuntime,
} from "../src/module-sdk/runtime.js";

const snapshot: GraphSnapshot = {
  manifest: {
    format: "toporealm.graph/v1",
    id: "runtime-contract",
    sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
  },
  objects: [],
  relations: [],
  revision: 1,
};

const snapshotContext: ValidationContext = { kind: "snapshot", candidate: snapshot };

describe("ModuleRuntime 与模块 Schema 执行边界", () => {
  it("从单一 runtime export 规范化可选 execute 与 validate", () => {
    const runtime = normalizeModuleRuntime({
      execute: () => ({ result: "ok" }),
      validate: (validatorId: string) => validatorId === "rule" ? [] : [{ code: "UNKNOWN", message: "unknown", severity: "error" }],
    }, "workflow");

    expect(runtime.execute).toBeTypeOf("function");
    expect(runtime.validate).toBeTypeOf("function");
    expect(Object.keys(runtime).sort()).toEqual(["execute", "validate"]);
  });

  it("只从模块目录内的单一 runtime entry 装载实现", async () => {
    const root = new URL("./fixtures/packages/example-module/", import.meta.url).pathname.replace(/^\/(.:\/)/, "$1");
    const runtime = await loadModuleRuntime(root, "runtime/index.js", "example");
    expect(runtime.execute).toBeTypeOf("function");
    await expect(loadModuleRuntime(root, "../outside.js", "example")).rejects.toMatchObject({ code: "INVALID_MODULE_RUNTIME" });
  });

  it("按 validator ID 调用只读上下文，并规范化模块诊断", () => {
    const runtime: ModuleRuntime = {
      validate: (validatorId, context) => {
        expect(validatorId).toBe("status-transition");
        expect(context).toEqual(snapshotContext);
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.candidate)).toBe(true);
        return [{ code: "WORKFLOW_STATUS", message: "状态无效", severity: "error", entityId: "task-1" }];
      },
    };

    expect(runModuleValidator("workflow", { id: "status-transition", mode: "snapshot" }, runtime, snapshotContext)).toEqual({
      ok: false,
      complete: true,
      diagnostics: [{
        code: "WORKFLOW_STATUS",
        message: "状态无效",
        severity: "error",
        entityId: "task-1",
        moduleId: "workflow",
        validatorId: "status-transition",
      }],
    });
  });

  it("把 validator 缺失、异常和非法输出转换成稳定失败语义", () => {
    const missing = runModuleValidator("workflow", { id: "rule", mode: "snapshot" }, {}, snapshotContext);
    expect(missing).toMatchObject({ ok: false, complete: false, diagnostics: [{ code: VALIDATION_CODES.VALIDATOR_UNAVAILABLE, severity: "error" }] });

    const throwing: ModuleRuntime = { validate: () => { throw new Error("boom"); } };
    expect(runModuleValidator("workflow", { id: "rule", mode: "snapshot" }, throwing, snapshotContext)).toMatchObject({
      ok: false,
      complete: false,
      diagnostics: [{ code: VALIDATION_CODES.VALIDATOR_EXCEPTION, severity: "error" }],
    });

    const invalid = { validate: () => [{ message: "missing code" }] } as unknown as ModuleRuntime;
    expect(runModuleValidator("workflow", { id: "rule", mode: "snapshot" }, invalid, snapshotContext)).toMatchObject({
      ok: false,
      complete: false,
      diagnostics: [{ code: VALIDATION_CODES.INVALID_DIAGNOSTIC, severity: "error" }],
    });
  });

  it("编译并执行 JSON Schema 2020-12，只校验模块私有 data", () => {
    const compiled = compileModulePrivateSchema({
      id: "task-data",
      moduleId: "workflow",
      target: { area: "data", kind: "workflow.task" },
      declaration: {
        $schema: JSON_SCHEMA_2020_12,
        type: "object",
        required: ["status"],
        properties: { status: { enum: ["pending", "running"] } },
        additionalProperties: true,
      },
    });

    expect(compiled.legacy).toBe(false);
    expect(compiled.validate({ status: "pending" }, "task-1")).toEqual([]);
    expect(compiled.validate({ status: "passed" }, "task-1")).toMatchObject([{ code: VALIDATION_CODES.MODULE_SCHEMA_INVALID, entityId: "task-1", moduleId: "workflow" }]);
  });

  it("把当前 required 简写转换成私有 Schema，并给出兼容 notice", () => {
    const compiled = compileModulePrivateSchema({
      id: "task-data",
      moduleId: "workflow",
      target: { area: "data", kind: "workflow.task" },
      declaration: { label: "Workflow task", required: ["label", "data.status"] },
    });

    expect(compiled.legacy).toBe(true);
    expect(compiled.requiredCoreFields).toEqual(["label"]);
    expect(compiled.notice).toMatchObject({ code: "LEGACY_SCHEMA_ADAPTED", moduleId: "workflow", complete: false });
    expect(compiled.validate({ status: "pending" }, "task-1")).toEqual([]);
    expect(compiled.validate({}, "task-1")).toMatchObject([{ code: VALIDATION_CODES.MODULE_SCHEMA_INVALID, entityId: "task-1" }]);
  });

  it("旧版 relation 仅声明核心字段时不强制存在 data", () => {
    const compiled = compileModulePrivateSchema({
      id: "dependency",
      moduleId: "workflow",
      target: { area: "data", kind: "workflow.depends" },
      declaration: { required: ["source", "target", "direction"] },
    });
    expect(compiled.legacy).toBe(true);
    expect(compiled.validate(undefined, "task-a-depends-task-b")).toEqual([]);
    expect(compiled.notice).toMatchObject({ code: "LEGACY_SCHEMA_ADAPTED", complete: false });
  });
});
