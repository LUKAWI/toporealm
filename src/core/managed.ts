import type {
  EntityId,
  GraphManifest,
  GraphPatch,
  GraphSnapshot,
  MutationPlan,
} from "./types.js";
import type { GraphValidationResult } from "./validate.js";
import { validateGraph } from "./validate.js";
import { CoreError } from "./errors.js";
import { GraphStore } from "./store.js";
import type { GraphRegistrySnapshot } from "../module-sdk/registry.js";
import { runModuleValidator, type CompiledModulePrivateSchema, type ModuleRuntime, type RuntimeValidatorRef } from "../module-sdk/runtime.js";
import { sortValidationDiagnostics, type ValidationDiagnostic } from "../module-sdk/validation.js";
import type { ValidationContext } from "./validation-types.js";

/** A deterministic, structured diagnostic returned by a managed operation. */
export interface ManagedGraphDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly entityId?: EntityId;
  readonly path?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A non-fatal recovery, adoption, or compatibility message. */
export interface ManagedGraphNotice {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly fromRevision?: number;
  readonly toRevision?: number;
  readonly segmentId?: string;
  readonly redoCleared?: boolean;
  readonly auditPreserved?: boolean;
  readonly preserved?: boolean;
  readonly complete?: boolean;
  readonly missingModules?: readonly string[];
}

/** Fields shared by every ManagedGraph operation result. */
export interface ManagedGraphResult {
  readonly revision: number;
  readonly diagnostics: readonly ManagedGraphDiagnostic[];
  readonly complete: boolean;
  readonly notice?: ManagedGraphNotice;
}

/** Result of reading the current graph snapshot. */
export interface ManagedGraphReadResult extends ManagedGraphResult {
  readonly snapshot: GraphSnapshot;
}

/** Result of validating the current graph without changing it. */
export interface ManagedGraphValidationResult extends ManagedGraphResult {}

export interface ManagedGraphHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** Result shared by commit, undo, and redo. */
export interface ManagedGraphMutationResult extends ManagedGraphResult {
  readonly snapshot: GraphSnapshot;
  readonly patch: GraphPatch;
  readonly history: ManagedGraphHistory;
}

/** Alias that makes a commit's result explicit at call sites. */
export type ManagedGraphCommitResult = ManagedGraphMutationResult;

/** Alias that makes an undo result explicit at call sites. */
export type ManagedGraphUndoResult = ManagedGraphMutationResult;

/** Alias that makes a redo result explicit at call sites. */
export type ManagedGraphRedoResult = ManagedGraphMutationResult;

/**
 * The one-round compatibility seam for old graph fixtures.
 *
 * The legacy reader deliberately has no mutation, undo, or redo method. Its
 * implementation belongs to `/core/legacy`; this type only freezes the
 * read-only boundary used by that adapter.
 */
export interface LegacyGraphReader {
  read(): GraphSnapshot;
  validate(): GraphValidationResult;
}

/**
 * Core's only supported graph write/read seam in 0.2.
 *
 * The interface intentionally exposes exactly five operations. Persistence,
 * locking, recovery, module loading, and command dispatch remain
 * implementation concerns of Core.
 */
export interface ManagedGraph {
  read(): ManagedGraphReadResult;
  validate(): ManagedGraphValidationResult;
  commit(plan: MutationPlan): ManagedGraphCommitResult;
  undo(expectedRevision?: number): ManagedGraphUndoResult;
  redo(expectedRevision?: number): ManagedGraphRedoResult;
}

/**
 * Internal command vocabulary for ManagedGraph implementations.
 *
 * This type is intentionally not exported. Callers use the five methods on
 * ManagedGraph rather than constructing or dispatching commands themselves.
 */
type GraphCommand =
  | { readonly kind: "read" }
  | { readonly kind: "validate" }
  | { readonly kind: "commit"; readonly plan: MutationPlan }
  | { readonly kind: "undo"; readonly expectedRevision?: number }
  | { readonly kind: "redo"; readonly expectedRevision?: number };

export interface ManagedValidatorRef extends RuntimeValidatorRef {
  readonly moduleId: string;
  readonly namespace: string;
}

export interface ManagedGraphOptions {
  readonly registry?: GraphRegistrySnapshot;
  readonly schemas?: readonly CompiledModulePrivateSchema[];
  readonly validators?: readonly ManagedValidatorRef[];
  readonly runtimes?: Readonly<Record<string, ModuleRuntime>>;
}

export function createManagedGraph(store: GraphStore, options: ManagedGraphOptions = {}): ManagedGraph {
  return new ManagedGraphController(store, options);
}

/** Bootstrap an empty graph through Core's validated, journalled persistence boundary. */
export function initializeManagedGraph(store: GraphStore, manifest: GraphManifest): ManagedGraphReadResult {
  const controller = new ManagedGraphController(store, {});
  const snapshot = store.initializeManaged(manifest, (candidate) => controller.assertSnapshotValid(candidate));
  return controller.readInitialized(snapshot);
}

class ManagedGraphController implements ManagedGraph {
  constructor(private readonly store: GraphStore, private readonly options: ManagedGraphOptions) {}

  read(): ManagedGraphReadResult { return this.execute({ kind: "read" }) as ManagedGraphReadResult; }
  validate(): ManagedGraphValidationResult { return this.execute({ kind: "validate" }) as ManagedGraphValidationResult; }
  commit(plan: MutationPlan): ManagedGraphCommitResult { return this.execute({ kind: "commit", plan }) as ManagedGraphCommitResult; }
  undo(expectedRevision?: number): ManagedGraphUndoResult {
    return this.execute(expectedRevision === undefined ? { kind: "undo" } : { kind: "undo", expectedRevision }) as ManagedGraphUndoResult;
  }
  redo(expectedRevision?: number): ManagedGraphRedoResult {
    return this.execute(expectedRevision === undefined ? { kind: "redo" } : { kind: "redo", expectedRevision }) as ManagedGraphRedoResult;
  }

  assertSnapshotValid(snapshot: GraphSnapshot): void {
    this.assertValid(this.validationResult(snapshot, { kind: "snapshot", candidate: snapshot }));
  }

  readInitialized(snapshot: GraphSnapshot): ManagedGraphReadResult {
    return { ...this.validationResult(snapshot, { kind: "snapshot", candidate: snapshot }), snapshot };
  }

  private execute(command: GraphCommand): ManagedGraphResult {
    if (command.kind === "read" || command.kind === "validate") {
      const missingModules = (this.options.registry?.modules ?? []).filter((item) => item.status === "unavailable").map((item) => item.id);
      return this.store.readManaged((current, notice) => {
        const validation = this.validationResult(current, { kind: "snapshot", candidate: current });
        return command.kind === "read" ? { ...validation, ...(notice ? { notice } : {}), snapshot: current } : { ...validation, ...(notice ? { notice } : {}) };
      }, missingModules);
    }
    let validation: ManagedGraphValidationResult | undefined;
    const missingModules = (this.options.registry?.modules ?? []).filter((item) => item.status === "unavailable").map((item) => item.id);
    const mutation = this.store.executeManaged(command, ({ before, candidate, patch }) => {
      validation = this.validationResult(candidate, { kind: "transition", before, candidate, changes: patch });
      this.assertValid(validation);
    }, missingModules);
    if (!validation && mutation.notice) {
      const absorbedValidation = this.validationResult(mutation.snapshot, { kind: "snapshot", candidate: mutation.snapshot });
      return { ...mutation, revision: mutation.snapshot.revision, diagnostics: absorbedValidation.diagnostics, complete: absorbedValidation.complete };
    }
    if (!validation) throw new CoreError({ code: "INTERNAL_ERROR", message: "提交未执行候选图校验。" });
    return {
      ...mutation,
      revision: mutation.snapshot.revision,
      diagnostics: validation.diagnostics,
      complete: validation.complete,
      ...(validation.notice ? { notice: validation.notice } : {}),
    };
  }

  private validationResult(snapshot: GraphSnapshot, context: import("./validation-types.js").ValidationContext): ManagedGraphValidationResult {
    const basic = validateGraph(snapshot, this.options.registry);
    const diagnostics: ValidationDiagnostic[] = [
      ...basic.errors.map((item) => ({ ...item })),
      ...basic.warnings.map((item) => ({ ...item })),
    ];
    if (context.kind === "transition") diagnostics.push(...missingModuleMutationDiagnostics(context.before, context.candidate, this.options.registry));
    let complete = basic.complete;
    for (const schema of this.options.schemas ?? []) {
      const records = [...snapshot.objects, ...snapshot.relations];
      for (const record of records) {
        const matches = schema.target.area === "data" ? record.kind === schema.target.kind : Object.hasOwn(record.capabilities ?? {}, schema.target.capability);
        if (!matches) continue;
        const value = schema.target.area === "data" ? record.data : record.capabilities?.[schema.target.capability];
        diagnostics.push(...schema.validate(value as import("./validation-types.js").ReadonlyJsonValue | undefined, record.id));
      }
      if (schema.legacy) complete = false;
    }
    for (const validator of [...(this.options.validators ?? [])].filter((item) => item.mode === context.kind).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id))) {
      const result = runModuleValidator(validator.moduleId, validator, this.options.runtimes?.[validator.moduleId] ?? {}, context);
      diagnostics.push(...result.diagnostics);
      complete &&= result.complete;
    }
    const sorted = sortValidationDiagnostics(diagnostics);
    const legacy = (this.options.schemas ?? []).find((schema) => schema.notice)?.notice;
    return {
      revision: snapshot.revision,
      diagnostics: sorted,
      complete,
      ...(legacy ? {
        notice: {
          code: legacy.code,
          message: legacy.message,
          complete: false,
          details: { moduleId: legacy.moduleId, schemaId: legacy.schemaId },
        },
      } : {}),
    };
  }

  private assertValid(result: ManagedGraphValidationResult): void {
    if (result.diagnostics.some((item) => item.severity === "error")) throw new CoreError({ code: "VALIDATION_FAILED", message: "候选图未通过完整校验。", details: { diagnostics: result.diagnostics } });
  }
}

function missingModuleMutationDiagnostics(before: ValidationContext["candidate"], candidate: ValidationContext["candidate"], registry?: GraphRegistrySnapshot): ValidationDiagnostic[] {
  const missing = new Set((registry?.modules ?? []).filter((item) => item.status === "unavailable").flatMap((item) => item.namespace ? [item.namespace] : []));
  if (missing.size === 0) return [];
  const diagnostics: ValidationDiagnostic[] = [];
  const inspect = <T extends { readonly id: string; readonly kind: string; readonly data?: unknown; readonly capabilities?: Readonly<Record<string, unknown>> }>(
    previousRecords: readonly T[],
    nextRecords: readonly T[],
    relation: boolean,
  ): void => {
    const previousById = new Map(previousRecords.map((record) => [record.id, record]));
    const nextById = new Map(nextRecords.map((record) => [record.id, record]));
    for (const id of [...new Set([...previousById.keys(), ...nextById.keys()])].sort()) {
      const previous = previousById.get(id);
      const next = nextById.get(id);
      const ownedNamespaces = [previous?.kind, next?.kind].filter((kind): kind is string => Boolean(kind)).map(namespaceOf).filter((namespace) => missing.has(namespace));
      const protectedCapabilities = [...new Set([
        ...Object.keys(previous?.capabilities ?? {}),
        ...Object.keys(next?.capabilities ?? {}),
      ].filter((key) => missing.has(namespaceOf(key))))].sort();
      const owned = ownedNamespaces.length > 0;
      if (!owned && protectedCapabilities.length === 0) continue;
      const changed = !previous || !next
        || previous.kind !== next.kind
        || (owned && (!jsonEqual(previous.data, next.data) || !jsonEqual(previous.capabilities, next.capabilities)))
        || protectedCapabilities.some((key) => !jsonEqual(previous.capabilities?.[key], next.capabilities?.[key]))
        || (relation && owned && (previous as T & { source?: string }).source !== (next as T & { source?: string }).source)
        || (relation && owned && (previous as T & { target?: string }).target !== (next as T & { target?: string }).target)
        || (relation && owned && (previous as T & { direction?: string }).direction !== (next as T & { direction?: string }).direction);
      if (changed) diagnostics.push({
        code: "MISSING_MODULE_PRIVATE_MUTATION",
        message: `模块缺失时不能新增、修改或删除受保护记录 ${id} 的领域私有区域。`,
        severity: "error",
        entityId: id,
        details: { missingNamespaces: [...new Set([...ownedNamespaces, ...protectedCapabilities.map(namespaceOf)])].sort() },
      });
    }
  };
  inspect(before.objects, candidate.objects, false);
  inspect(before.relations, candidate.relations, true);
  return diagnostics;
}

function namespaceOf(value: string): string {
  const separator = value.indexOf(".");
  return separator === -1 ? value : value.slice(0, separator);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
