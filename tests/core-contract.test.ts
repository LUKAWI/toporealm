import { describe, expect, it } from "vitest";
import { GRAPH_FORMAT, coreSurface, moduleSurface } from "../src/index.js";

describe("M0 public contract", () => {
  it("keeps the alpha graph format in Core", () => {
    expect(GRAPH_FORMAT).toBe("toporealm.graph/v1alpha1");
    expect(coreSurface.graphFormat).toBe(GRAPH_FORMAT);
  });

  it("keeps module format separate from graph format", () => {
    expect(moduleSurface.manifestFormat).toBe("toporealm.module/v1alpha1");
    expect(moduleSurface.manifestFormat).not.toBe(GRAPH_FORMAT);
  });
});
