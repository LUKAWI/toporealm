import { describe, expect, it } from "vitest";
import { GraphApiError, ToporealmApi, WebGraphState, type GraphPatch, type GraphSnapshot } from "./protocol";

function snapshot(revision = 0): GraphSnapshot {
  return {
    manifest: {
      format: "toporealm.graph/v1",
      id: "demo",
      label: "Demo",
      sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" },
    },
    objects: [],
    relations: [],
    revision,
  };
}

function object(id: string) {
  return { id, kind: "plain", label: id };
}

function patch(fromRevision: number, toRevision: number, added = [object("alpha")]): GraphPatch {
  return {
    fromRevision,
    toRevision,
    objects: { added, updated: [], deleted: [] },
    relations: { added: [], updated: [], deleted: [] },
    manifestChanged: false,
  };
}

describe("browser graph protocol", () => {
  it("连续应用 MutationPlan 返回的 patch 并推进本地 revision", () => {
    const state = new WebGraphState(snapshot());
    state.applyPatch(patch(0, 1));
    state.applyPatch({
      ...patch(1, 2, []),
      objects: { added: [], updated: [{ ...object("alpha"), label: "Alpha" }], deleted: [] },
    });
    expect(state.snapshot).toMatchObject({ revision: 2, objects: [{ id: "alpha", label: "Alpha" }] });
  });

  it("patch gap 不修改本地快照，并给出可识别错误码", () => {
    const state = new WebGraphState(snapshot());
    expect(() => state.applyPatch(patch(2, 3))).toThrowError(GraphApiError);
    try {
      state.applyPatch(patch(2, 3));
    } catch (error) {
      expect(error).toMatchObject({ code: "PATCH_GAP", status: 409 });
    }
    expect(state.snapshot).toMatchObject({ revision: 0, objects: [] });
  });

  it("把 409 稳定错误响应转换为 GraphApiError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "REVISION_CONFLICT", message: "版本已变化" } }), { status: 409 });
    try {
      await expect(new ToporealmApi().undo(0)).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409, message: "版本已变化" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
