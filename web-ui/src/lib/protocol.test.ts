import { describe, expect, it } from "vitest";
import { TopoError, type GraphSnapshot } from "./protocol";
import { PatchGapError, WebGraphState, displayOf, isRecoverableError, titleOf } from "./protocol";

function snapshot(revision = 0): GraphSnapshot {
  return { graphId: "demo", revision, objects: [], relations: [] };
}

function object(id: string, title?: string) {
  return { id, kind: "plain", payload: title !== undefined ? { title } : {} };
}

function patch(fromRevision: number, toRevision: number, added = [object("alpha", "Alpha")]) {
  return {
    fromRevision,
    toRevision,
    objects: { added, updated: [], deleted: [] },
    relations: { added: [], updated: [], deleted: [] },
  };
}

describe("1.0 浏览器视图词汇", () => {
  it("titleOf/displayOf：payload.title 约定投影，缺省回落 id", () => {
    expect(titleOf(object("a", "标题"))).toBe("标题");
    expect(titleOf(object("a"))).toBe("");
    expect(displayOf(object("a"))).toBe("a");
    expect(displayOf(object("a", "标题"))).toBe("标题");
  });

  it("连续 patch 增量推进本地 revision", () => {
    const state = new WebGraphState(snapshot());
    state.applyPatch(patch(0, 1));
    state.applyPatch({
      ...patch(1, 2, []),
      objects: { added: [], updated: [{ ...object("alpha", "新名") }], deleted: [] },
    });
    expect(state.snapshot).toMatchObject({ revision: 2, objects: [{ id: "alpha", payload: { title: "新名" } }] });
  });

  it("patch gap 不修改本地快照，抛视图层 PatchGapError", () => {
    const state = new WebGraphState(snapshot());
    expect(() => state.applyPatch(patch(2, 3))).toThrowError(PatchGapError);
    expect(() => state.applyPatch(patch(2, 3))).toThrowError(/r0/);
    expect(state.snapshot).toMatchObject({ revision: 0, objects: [] });
  });

  it("isRecoverableError：IF_REVISION_MISMATCH 与 PatchGapError 可自愈；其他错误不是", () => {
    expect(isRecoverableError(new TopoError({ code: "IF_REVISION_MISMATCH", message: "x" }))).toBe(true);
    expect(isRecoverableError(new PatchGapError(1, 2))).toBe(true);
    expect(isRecoverableError(new TopoError({ code: "VETOED", message: "x" }))).toBe(false);
    expect(isRecoverableError(new Error("x"))).toBe(false);
  });
});
