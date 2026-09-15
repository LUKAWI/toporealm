import type { ModuleActionRuntime } from "./actions.js";
import type {
  JsonSchema202012,
  ModulePrivateSchema,
  ReadonlyGraphPatch,
  SnapshotValidationContext,
  TransitionValidationContext,
  ValidationCode,
  ValidationContext,
  ValidationDiagnostic,
  ValidationMode,
  ValidationResult,
} from "../core/validation-types.js";

export type {
  BuiltInValidationCode,
  CoreEnvelope,
  CoreObjectEnvelope,
  CoreRelationEnvelope,
  DeepReadonly,
  JsonSchema202012,
  JsonSchema202012Document,
  JsonSchema202012Root,
  JsonSchemaType,
  JsonValue,
  ModulePrivateField,
  ModulePrivateRegion,
  ModulePrivateSchema,
  ModuleSchemaArea,
  ModuleSchemaTarget,
  ReadonlyGraphPatch,
  ReadonlyGraphSnapshot,
  ReadonlyJsonObject,
  ReadonlyJsonValue,
  SnapshotValidationContext,
  TransitionValidationContext,
  ValidatedObject,
  ValidatedRelation,
  ValidationCode,
  ValidationContext,
  ValidationDiagnostic,
  ValidationMode,
  ValidationResult,
  ValidationSeverity,
} from "../core/validation-types.js";

export {
  CORE_ENVELOPE_FIELDS,
  JSON_SCHEMA_2020_12,
  MODULE_PRIVATE_FIELDS,
  VALIDATION_CODES,
} from "../core/validation-types.js";

/** A validator is synchronous, deterministic, read-only, and returns diagnostics only. */
export type SnapshotValidator = (context: SnapshotValidationContext) => readonly ValidationDiagnostic[];
export type TransitionValidator = (context: TransitionValidationContext) => readonly ValidationDiagnostic[];
export type ModuleValidator = (validatorId: string, context: ValidationContext) => readonly ValidationDiagnostic[];

/** Runtime shape exposed to the loader; all fields are optional because modules may be declarative-only. */
export interface ModuleRuntime extends Partial<ModuleActionRuntime> {
  readonly validate?: ModuleValidator;
}

/** Stable metadata for one validator registered by a module. */
export interface ModuleValidatorRegistration {
  readonly id: string;
  readonly mode: ValidationMode;
  readonly validate: ModuleValidator;
}

/** A schema contribution is private to one kind-data or capability-state region. */
export interface ModuleSchemaRegistration extends ModulePrivateSchema {
  readonly id: string;
  readonly moduleId: string;
}

/** Canonical diagnostic ordering: entity ID, code, path, module, validator, severity, message. */
export function sortValidationDiagnostics(
  diagnostics: readonly ValidationDiagnostic[],
): readonly ValidationDiagnostic[] {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((left, right) => {
      const leftKey = diagnosticSortKey(left.diagnostic);
      const rightKey = diagnosticSortKey(right.diagnostic);
      for (let index = 0; index < leftKey.length; index += 1) {
        const comparison = compareStrings(leftKey[index] ?? "", rightKey[index] ?? "");
        if (comparison !== 0) return comparison;
      }
      return left.index - right.index;
    })
    .map(({ diagnostic }) => diagnostic);
}

function diagnosticSortKey(diagnostic: ValidationDiagnostic): readonly string[] {
  return [
    diagnostic.entityId ?? "",
    diagnostic.code,
    diagnostic.path ?? "",
    diagnostic.moduleId ?? "",
    diagnostic.validatorId ?? "",
    diagnostic.severity,
    diagnostic.message,
  ];
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Keep the transition seam visibly tied to the existing patch summary type. */
export type ValidationChanges = ReadonlyGraphPatch;

/** The engine owns construction of this result; SDK code only names its stable shape. */
export type ValidationOutcome = ValidationResult;

/** Keeps the imported schema type discoverable from the module SDK entrypoint. */
export type ModuleSchema = JsonSchema202012;

/** Keeps the context union discoverable for runtime implementers without granting storage access. */
export type ValidatorContext = ValidationContext;

/** Error-code type used by runtime adapters when normalizing thrown or malformed output. */
export type ValidatorErrorCode = ValidationCode;
