import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { CoreError } from "../core/errors.js";
import {
  JSON_SCHEMA_2020_12,
  VALIDATION_CODES,
  type JsonSchema202012Root,
  type ModuleSchemaTarget,
  type ReadonlyJsonValue,
  type ValidationContext,
  type ValidationDiagnostic,
  type ValidationMode,
  type ValidationResult,
} from "../core/validation-types.js";
import { sortValidationDiagnostics, type ModuleRuntime } from "./validation.js";

export type { ModuleRuntime } from "./validation.js";

export interface RuntimeValidatorRef {
  readonly id: string;
  readonly mode: ValidationMode;
}

export interface LegacySchemaNotice {
  readonly code: "LEGACY_SCHEMA_ADAPTED";
  readonly moduleId: string;
  readonly schemaId: string;
  readonly complete: false;
  readonly message: string;
}

export interface ModulePrivateSchemaSource {
  readonly id: string;
  readonly moduleId: string;
  readonly target: ModuleSchemaTarget;
  readonly declaration: unknown;
}

export interface CompiledModulePrivateSchema {
  readonly id: string;
  readonly moduleId: string;
  readonly target: ModuleSchemaTarget;
  readonly schema: JsonSchema202012Root;
  readonly legacy: boolean;
  readonly requiredCoreFields: readonly string[];
  readonly notice?: LegacySchemaNotice;
  validate(value: ReadonlyJsonValue | undefined, entityId?: string): readonly ValidationDiagnostic[];
}

export function normalizeModuleRuntime(value: unknown, moduleId: string): ModuleRuntime {
  if (!value || typeof value !== "object") {
    throw new CoreError({ code: "INVALID_MODULE_RUNTIME", message: `模块 ${moduleId} 的 runtime export 必须是对象。` });
  }
  const candidate = value as { execute?: unknown; validate?: unknown };
  if (candidate.execute !== undefined && typeof candidate.execute !== "function") {
    throw new CoreError({ code: "INVALID_MODULE_RUNTIME", message: `模块 ${moduleId} 的 execute 必须是函数。` });
  }
  if (candidate.validate !== undefined && typeof candidate.validate !== "function") {
    throw new CoreError({ code: "INVALID_MODULE_RUNTIME", message: `模块 ${moduleId} 的 validate 必须是函数。` });
  }
  if (candidate.execute === undefined && candidate.validate === undefined) {
    throw new CoreError({ code: "INVALID_MODULE_RUNTIME", message: `模块 ${moduleId} 的 runtime 没有 execute 或 validate。` });
  }
  const runtime: Record<string, unknown> = {};
  if (typeof candidate.execute === "function") runtime.execute = candidate.execute.bind(value);
  if (typeof candidate.validate === "function") runtime.validate = candidate.validate.bind(value);
  return Object.freeze(runtime) as ModuleRuntime;
}

export async function loadModuleRuntime(moduleRoot: string, entry: string, moduleId: string): Promise<ModuleRuntime> {
  const root = resolve(moduleRoot);
  const target = resolve(root, entry);
  const rel = relative(root, target);
  if (!entry || rel.startsWith("..") || resolve(root, rel) !== target) {
    throw new CoreError({ code: "INVALID_MODULE_RUNTIME", message: `模块 ${moduleId} 的 runtime entry 越出模块目录。` });
  }
  let imported: { default?: unknown; runtime?: unknown };
  try {
    imported = await import(pathToFileURL(target).href) as { default?: unknown; runtime?: unknown };
  } catch (error) {
    throw new CoreError({
      code: "RUNTIME_FAILED",
      message: `无法装载模块 ${moduleId} 的 runtime。`,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  return normalizeModuleRuntime(imported.default ?? imported.runtime, moduleId);
}

export function runModuleValidator(
  moduleId: string,
  validator: RuntimeValidatorRef,
  runtime: ModuleRuntime,
  context: ValidationContext,
): ValidationResult {
  if (validator.mode !== context.kind) {
    return invalidValidatorResult(moduleId, validator.id, `validator mode=${validator.mode} 不能处理 ${context.kind} 上下文。`);
  }
  if (!runtime.validate) {
    return {
      ok: false,
      complete: false,
      diagnostics: [{
        code: VALIDATION_CODES.VALIDATOR_UNAVAILABLE,
        message: `模块 ${moduleId} 未提供 validator ${validator.id}。`,
        severity: "error",
        moduleId,
        validatorId: validator.id,
      }],
    };
  }
  let output: readonly ValidationDiagnostic[];
  try {
    output = runtime.validate(validator.id, deepFreeze(structuredClone(context)));
  } catch (error) {
    return {
      ok: false,
      complete: false,
      diagnostics: [{
        code: VALIDATION_CODES.VALIDATOR_EXCEPTION,
        message: `模块 ${moduleId} 的 validator ${validator.id} 抛出异常。`,
        severity: "error",
        moduleId,
        validatorId: validator.id,
        details: { cause: error instanceof Error ? error.message : String(error) },
      }],
    };
  }
  if (!Array.isArray(output) || output.some((item) => !isValidationDiagnostic(item))) {
    return invalidValidatorResult(moduleId, validator.id, "validator 必须返回结构化 diagnostic 数组。");
  }
  const diagnostics = sortValidationDiagnostics(output.map((item) => ({ ...item, moduleId, validatorId: validator.id })));
  return { ok: !diagnostics.some((item) => item.severity === "error"), complete: true, diagnostics };
}

export function compileModulePrivateSchema(source: ModulePrivateSchemaSource): CompiledModulePrivateSchema {
  const adapted = isFormalSchema(source.declaration)
    ? { schema: source.declaration, legacy: false as const, requiredCoreFields: [] as readonly string[] }
    : adaptLegacySchema(source);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(adapted.schema);
  } catch (error) {
    throw new CoreError({
      code: "INVALID_MODULE_SCHEMA",
      message: `模块 ${source.moduleId} 的 Schema ${source.id} 无法编译。`,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  const notice = adapted.legacy ? {
    code: "LEGACY_SCHEMA_ADAPTED" as const,
    moduleId: source.moduleId,
    schemaId: source.id,
    complete: false as const,
    message: `模块 ${source.moduleId} 的 Schema ${source.id} 使用 0.2.x 简写兼容 adapter。`,
  } : undefined;
  const compiled: CompiledModulePrivateSchema = {
    id: source.id,
    moduleId: source.moduleId,
    target: source.target,
    schema: adapted.schema,
    legacy: adapted.legacy,
    requiredCoreFields: adapted.requiredCoreFields,
    validate(value, entityId) {
      if (validate(value)) return [];
      return (validate.errors ?? []).map((error) => {
        const diagnostic: ValidationDiagnostic = {
          code: VALIDATION_CODES.MODULE_SCHEMA_INVALID,
          message: error.message ? `模块字段${error.instancePath || "/"} ${error.message}` : "模块字段不符合 Schema。",
          severity: "error",
          path: error.instancePath || "/",
          moduleId: source.moduleId,
          validatorId: source.id,
          details: { keyword: error.keyword },
        };
        return entityId === undefined ? diagnostic : { ...diagnostic, entityId };
      });
    },
  };
  return notice === undefined ? compiled : { ...compiled, notice };
}

function adaptLegacySchema(source: ModulePrivateSchemaSource): {
  readonly schema: JsonSchema202012Root;
  readonly legacy: true;
  readonly requiredCoreFields: readonly string[];
} {
  if (!source.declaration || typeof source.declaration !== "object" || Array.isArray(source.declaration)) {
    throw new CoreError({ code: "INVALID_MODULE_SCHEMA", message: `模块 ${source.moduleId} 的旧 Schema ${source.id} 必须是对象。` });
  }
  const declaration = source.declaration as { required?: unknown };
  const required = Array.isArray(declaration.required) && declaration.required.every((item) => typeof item === "string")
    ? declaration.required as string[]
    : [];
  const prefix = source.target.area === "data" ? "data." : `capabilities.${source.target.capability}.`;
  const privatePaths = required.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).filter(Boolean);
  const coreFields = required.filter((path) => !path.includes(".") && ["id", "kind", "label", "source", "target", "direction", "meta"].includes(path));
  return {
    // 旧版 relation 简写常常只声明 source/target/direction，没有 data。
    // 此时核心字段仍由基础校验负责，私有 data 不应被强制为对象。
    schema: privatePaths.length === 0 ? true : requiredPathsSchema(privatePaths),
    legacy: true,
    requiredCoreFields: [...new Set(coreFields)].sort(),
  };
}

function requiredPathsSchema(paths: readonly string[]): JsonSchema202012Root {
  const root: { $schema: typeof JSON_SCHEMA_2020_12; type: "object"; required: string[]; properties: Record<string, unknown>; additionalProperties: true } = {
    $schema: JSON_SCHEMA_2020_12,
    type: "object",
    required: [],
    properties: {},
    additionalProperties: true,
  };
  for (const path of paths) addRequiredPath(root, path.split(".").filter(Boolean));
  return root as JsonSchema202012Root;
}

function addRequiredPath(node: { required: string[]; properties: Record<string, unknown> }, parts: readonly string[]): void {
  const [head, ...tail] = parts;
  if (!head) return;
  if (!node.required.includes(head)) node.required.push(head);
  if (tail.length === 0) return;
  let child = node.properties[head] as { type: "object"; required: string[]; properties: Record<string, unknown>; additionalProperties: true } | undefined;
  if (!child) {
    child = { type: "object", required: [], properties: {}, additionalProperties: true };
    node.properties[head] = child;
  }
  addRequiredPath(child, tail);
}

function isFormalSchema(value: unknown): value is JsonSchema202012Root {
  return typeof value === "boolean" || Boolean(value && typeof value === "object" && (value as { $schema?: unknown }).$schema === JSON_SCHEMA_2020_12);
}

function isValidationDiagnostic(value: unknown): value is ValidationDiagnostic {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ValidationDiagnostic>;
  return typeof candidate.code === "string" && candidate.code.length > 0
    && typeof candidate.message === "string"
    && (candidate.severity === "error" || candidate.severity === "warning");
}

function invalidValidatorResult(moduleId: string, validatorId: string, message: string): ValidationResult {
  return {
    ok: false,
    complete: false,
    diagnostics: [{ code: VALIDATION_CODES.INVALID_DIAGNOSTIC, message, severity: "error", moduleId, validatorId }],
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
