import type {
  EntityId,
  GraphPatch,
  GraphSnapshot,
  RelationDirection,
} from "./types.js";

/** JSON values are the only values that can cross the module validation boundary. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

export type ReadonlyJsonObject = { readonly [key: string]: ReadonlyJsonValue };

/** Deep readonly is intentional: a validator must not be able to mutate a candidate. */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[]
      : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type ReadonlyGraphSnapshot = DeepReadonly<GraphSnapshot>;
export type ReadonlyGraphPatch = DeepReadonly<GraphPatch>;

/** Fields owned by Core in every object envelope. */
export interface CoreObjectEnvelope {
  readonly id: EntityId;
  readonly kind: string;
  readonly label: string;
  readonly meta?: ReadonlyJsonObject;
}

/** Fields owned by Core in every relation envelope. */
export interface CoreRelationEnvelope {
  readonly id: EntityId;
  readonly kind: string;
  readonly source: EntityId;
  readonly target: EntityId;
  readonly direction: RelationDirection;
  readonly label?: string;
  readonly meta?: ReadonlyJsonObject;
}

export type CoreEnvelope = CoreObjectEnvelope | CoreRelationEnvelope;

/** Private regions are retained by Core but interpreted only by the owning module. */
export interface ModulePrivateRegion {
  readonly data?: ReadonlyJsonObject;
  readonly capabilities?: ReadonlyJsonObject;
}

export type ValidatedObject = CoreObjectEnvelope & ModulePrivateRegion;
export type ValidatedRelation = CoreRelationEnvelope & ModulePrivateRegion;

export const CORE_ENVELOPE_FIELDS = [
  "id",
  "kind",
  "label",
  "source",
  "target",
  "direction",
  "meta",
] as const;

export const MODULE_PRIVATE_FIELDS = ["data", "capabilities"] as const;

export type ModulePrivateField = (typeof MODULE_PRIVATE_FIELDS)[number];
export type ModuleSchemaArea = "data" | "capabilities";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;
export type JsonSchemaType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

/** A JSON Schema 2020-12 document, including the legal boolean schemas. */
export type JsonSchema202012 = boolean | JsonSchema202012Document;

/** A module declaration must identify its root dialect; nested subschemas may omit `$schema`. */
export type JsonSchema202012Root = boolean | (JsonSchema202012Document & { readonly $schema: typeof JSON_SCHEMA_2020_12 });

export interface JsonSchema202012Document {
  readonly $schema?: typeof JSON_SCHEMA_2020_12;
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema202012>>;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema202012>>;
  readonly patternProperties?: Readonly<Record<string, JsonSchema202012>>;
  readonly additionalProperties?: boolean | JsonSchema202012;
  readonly items?: JsonSchema202012;
  readonly prefixItems?: readonly JsonSchema202012[];
  readonly allOf?: readonly JsonSchema202012[];
  readonly anyOf?: readonly JsonSchema202012[];
  readonly oneOf?: readonly JsonSchema202012[];
  readonly not?: JsonSchema202012;
  readonly if?: JsonSchema202012;
  readonly then?: JsonSchema202012;
  readonly else?: JsonSchema202012;
  readonly format?: string;
  readonly title?: string;
  readonly description?: string;
  readonly [keyword: string]: unknown;
}

export type ModuleSchemaTarget =
  | { readonly area: "data"; readonly kind: string }
  | { readonly area: "capabilities"; readonly capability: string };

/** A module schema may describe only one private data or capability-state region. */
export interface ModulePrivateSchema {
  readonly target: ModuleSchemaTarget;
  readonly schema: JsonSchema202012Root;
}

export type ValidationMode = "snapshot" | "transition";

/** Snapshot validators receive only the complete candidate graph. */
export interface SnapshotValidationContext {
  readonly kind: "snapshot";
  readonly candidate: ReadonlyGraphSnapshot;
}

/** Transition validators additionally receive the immutable pre-change graph and patch. */
export interface TransitionValidationContext {
  readonly kind: "transition";
  readonly before: ReadonlyGraphSnapshot;
  readonly candidate: ReadonlyGraphSnapshot;
  readonly changes: ReadonlyGraphPatch;
}

export type ValidationContext = SnapshotValidationContext | TransitionValidationContext;

export const VALIDATION_CODES = {
  CORE_ENVELOPE_INVALID: "CORE_ENVELOPE_INVALID",
  CORE_DUPLICATE_ID: "CORE_DUPLICATE_ID",
  CORE_DANGLING_RELATION: "CORE_DANGLING_RELATION",
  MODULE_SCHEMA_INVALID: "MODULE_SCHEMA_INVALID",
  MODULE_UNAVAILABLE: "MODULE_UNAVAILABLE",
  VALIDATOR_UNAVAILABLE: "VALIDATOR_UNAVAILABLE",
  VALIDATOR_EXCEPTION: "VALIDATOR_EXCEPTION",
  INVALID_DIAGNOSTIC: "INVALID_DIAGNOSTIC",
} as const;

export type BuiltInValidationCode = (typeof VALIDATION_CODES)[keyof typeof VALIDATION_CODES];
export type ValidationCode = BuiltInValidationCode | (string & {});
export type ValidationSeverity = "error" | "warning";

/** Every validator result is represented as a structured, sortable diagnostic. */
export interface ValidationDiagnostic {
  readonly code: ValidationCode;
  readonly message: string;
  readonly severity: ValidationSeverity;
  readonly entityId?: EntityId;
  readonly path?: string;
  readonly moduleId?: string;
  readonly validatorId?: string;
  readonly details?: ReadonlyJsonObject;
}

/** The result shape shared by basic and complete validation. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly complete: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
}
