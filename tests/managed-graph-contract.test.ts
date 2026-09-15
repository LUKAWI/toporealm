import { describe, expect, it } from "vitest";
import * as coreSurface from "../src/core/index.js";
import type * as packageSurface from "../src/index.js";
import type {
  GraphPatch,
  GraphSnapshot,
  MutationPlan,
} from "../src/core/types.js";
import type {
  LegacyGraphReader,
  ManagedGraph,
  ManagedGraphCommitResult,
  ManagedGraphDiagnostic,
  ManagedGraphHistory,
  ManagedGraphNotice,
  ManagedGraphReadResult,
  ManagedGraphRedoResult,
  ManagedGraphResult,
  ManagedGraphUndoResult,
  ManagedGraphValidationResult,
} from "../src/core/managed.js";
import type { GraphValidationResult } from "../src/core/validate.js";

// These imports are intentionally compile-time assertions. If either symbol
// becomes public, TypeScript reports an unused @ts-expect-error directive.
// @ts-expect-error GraphCommand is an implementation detail.
import type { GraphCommand } from "../src/core/managed.js";
// @ts-expect-error GraphStore is not part of the public Core surface.
import type { GraphStore } from "../src/core/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type ManagedGraphHasExactlyFiveMethods = Assert<Equal<
  keyof ManagedGraph,
  "read" | "validate" | "commit" | "undo" | "redo"
>>;
type LegacyGraphIsReadOnly = Assert<Equal<
  Exclude<keyof LegacyGraphReader, "read" | "validate">,
  never
>>;
type CoreDoesNotExportGraphStore = Assert<Equal<
  Extract<keyof typeof coreSurface, "GraphStore">,
  never
>>;
type PackageDoesNotExportGraphStore = Assert<Equal<
  Extract<keyof typeof packageSurface, "GraphStore">,
  never
>>;

function compileManagedGraphCalls(graph: ManagedGraph, plan: MutationPlan): {
  read: ManagedGraphReadResult;
  validation: ManagedGraphValidationResult;
  commit: ManagedGraphCommitResult;
  undo: ManagedGraphUndoResult;
  redo: ManagedGraphRedoResult;
} {
  const read = graph.read();
  const validation = graph.validate();
  const commit = graph.commit(plan);
  const undo = graph.undo(commit.revision);
  const redo = graph.redo(undo.revision);
  return { read, validation, commit, undo, redo };
}

function compileResultShape(result: ManagedGraphResult): {
  revision: number;
  diagnostics: readonly ManagedGraphDiagnostic[];
  complete: boolean;
  notice: ManagedGraphNotice | undefined;
} {
  return {
    revision: result.revision,
    diagnostics: result.diagnostics,
    complete: result.complete,
    notice: result.notice,
  };
}

function compileMutationShape(result: ManagedGraphCommitResult): {
  snapshot: GraphSnapshot;
  patch: GraphPatch;
  history: ManagedGraphHistory;
} {
  return { snapshot: result.snapshot, patch: result.patch, history: result.history };
}

function compileLegacyCalls(reader: LegacyGraphReader): {
  snapshot: GraphSnapshot;
  validation: GraphValidationResult;
} {
  return { snapshot: reader.read(), validation: reader.validate() };
}

describe("ManagedGraph 公共契约", () => {
  it("在 Core surface 中移除 GraphStore，并保留五方法契约", () => {
    expect(Object.keys(coreSurface)).not.toContain("GraphStore");
    expect(compileManagedGraphCalls).toBeTypeOf("function");
    expect(compileResultShape).toBeTypeOf("function");
    expect(compileMutationShape).toBeTypeOf("function");
    expect(compileLegacyCalls).toBeTypeOf("function");
  });
});
