import { describe, expect, it } from "vitest";
import { filterGraphSnapshot } from "./filter";
import type { GraphSnapshot } from "./protocol";

const snapshot: GraphSnapshot = {
  manifest: { format: "toporealm.graph/v1", id: "demo", sources: { objects: "objects/*.yaml", relations: "relations/*.yaml" } },
  objects: [
    { id: "q-1", kind: "research.question", label: "增量图" },
    { id: "t-1", kind: "workflow.task", label: "执行任务" },
  ],
  relations: [{ id: "depends-1", kind: "workflow.depends_on", source: "q-1", target: "t-1", direction: "directed" }],
  revision: 2,
};

describe("view-only graph filters", () => {
  it("按 query 缩小对象和关系，并在清空后恢复", () => {
    expect(filterGraphSnapshot(snapshot, { query: "增量" }).objects.map((object) => object.id)).toEqual(["q-1"]);
    expect(filterGraphSnapshot(snapshot, { query: "增量" }).relations).toHaveLength(0);
    expect(filterGraphSnapshot(snapshot)).toMatchObject({ objects: snapshot.objects, relations: snapshot.relations });
  });

  it("按 kind 过滤对象，同时只保留仍有可见端点的关系", () => {
    const result = filterGraphSnapshot(snapshot, { kind: "workflow.task" });
    expect(result.objects.map((object) => object.id)).toEqual(["t-1"]);
    expect(result.relations).toHaveLength(0);
  });
});
