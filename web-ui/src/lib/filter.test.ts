import { describe, expect, it } from "vitest";
import { filterGraphSnapshot } from "./filter";
import { obj, rel, snapshotOf, type FakeSessionState } from "./test-support";

const state: FakeSessionState = {
  revision: 2,
  objects: [obj("q-1", "research.question", "增量图"), obj("t-1", "workflow.task", "执行任务")],
  relations: [rel("depends-1", "workflow.depends_on", "q-1", "t-1")],
  canUndo: false,
  canRedo: false,
};
const snapshot = snapshotOf(state);

describe("view-only graph filters（1.0 payload.title 投影）", () => {
  it("按 query 缩小对象和关系，并在清空后恢复", () => {
    expect(filterGraphSnapshot(snapshot, { query: "增量" }).objects.map((object) => object.id)).toEqual(["q-1"]);
    expect(filterGraphSnapshot(snapshot, { query: "增量" }).relations).toHaveLength(0);
    expect(filterGraphSnapshot(snapshot, { query: "任务" }).relations).toHaveLength(0);
    expect(filterGraphSnapshot(snapshot)).toMatchObject({ objects: snapshot.objects, relations: snapshot.relations });
  });

  it("query 只命中单端点时关系隐藏（两端可见才保留）", () => {
    expect(filterGraphSnapshot(snapshot, { query: "增量图" }).relations).toHaveLength(0);
    expect(filterGraphSnapshot(snapshot, { query: "执行任务" }).relations).toHaveLength(0);
  });

  it("按 kind 过滤对象，同时只保留仍有可见端点的关系", () => {
    const result = filterGraphSnapshot(snapshot, { kind: "workflow.task" });
    expect(result.objects.map((object) => object.id)).toEqual(["t-1"]);
    expect(result.relations).toHaveLength(0);
  });
});
