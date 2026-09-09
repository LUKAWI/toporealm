import { describe, expect, it } from "vitest";
import { computeFitTransform, isUserViewportInput, seedGridLayout } from "./layout";

describe("canvas layout", () => {
  it("seedGridLayout 对同一数量给出确定、有限、按行铺开的坐标", () => {
    const first = seedGridLayout(5);
    const second = seedGridLayout(5);
    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    expect(first.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
    // 行内网格：x 覆盖多个列位（不退化为一点）
    expect(new Set(first.map((point) => point.x)).size).toBeGreaterThan(1);
  });

  it("seedGridLayout 处理空图，单节点落在原点附近", () => {
    expect(seedGridLayout(0)).toEqual([]);
    const single = seedGridLayout(1);
    expect(single).toHaveLength(1);
    expect(Math.abs(single[0].x)).toBeLessThanOrEqual(48);
    expect(single[0].y).toBe(0);
  });

  it("computeFitTransform 将点集缩放平移到视口中心", () => {
    const fit = computeFitTransform(
      [{ x: -100, y: -50 }, { x: 100, y: 50 }],
      800,
      600,
      { padding: 40, nodeRadius: 20, maxScale: 2 },
    );
    expect(fit).not.toBeNull();
    // 图宽 240（含半径）→ scale = (800-80)/240 ≈ 3 → capped 2；高度 140 → (600-80)/140 ≈ 3.71
    expect(fit!.scale).toBe(2);
    expect(fit!.tx).toBeCloseTo(400, 5);
    expect(fit!.ty).toBeCloseTo(300, 5);
  });

  it("computeFitTransform 忽略非有限坐标并在空点集时返回 null", () => {
    expect(computeFitTransform([], 800, 600)).toBeNull();
    const fit = computeFitTransform([{ x: Number.NaN, y: 10 }, { x: 50, y: 50 }], 800, 600);
    expect(fit).not.toBeNull();
  });

  it("只有真实视口输入才接管自动适配", () => {
    expect(isUserViewportInput(undefined)).toBe(false);
    expect(isUserViewportInput({ type: "zoom", isTrusted: false })).toBe(false);
    expect(isUserViewportInput({ type: "wheel", isTrusted: true })).toBe(true);
    expect(isUserViewportInput({ type: "dblclick", isTrusted: true })).toBe(true);
    expect(isUserViewportInput({ type: "touchstart", isTrusted: true })).toBe(true);
  });
});
