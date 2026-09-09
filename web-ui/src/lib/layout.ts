// 布局纯函数（可单测）：确定性种子网格 + "适应视图"的缩放/平移变换。
// 坐标只属于浏览器视图状态，从不写回 Core。
export interface LayoutPoint {
  x: number;
  y: number;
}

export interface FitTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** 只有浏览器产生的真实缩放手势才表示用户主动接管视口。 */
export function isUserViewportInput(source: { type?: string; isTrusted?: boolean } | null | undefined): boolean {
  if (!source?.isTrusted) return false;
  return source.type === "wheel"
    || source.type === "dblclick"
    || source.type === "touchstart"
    || source.type === "touchmove";
}

/** 确定性初始布局：按 id 序居中网格。同一快照重复加载得到同一坐标。 */
export function seedGridLayout(count: number, columnGap = 96, rowGap = 76): LayoutPoint[] {
  if (count <= 0) return [];
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * 1.6)));
  const rows = Math.ceil(count / columns);
  const centerX = ((columns - 1) / 2) * columnGap;
  const centerY = ((rows - 1) / 2) * rowGap;
  return Array.from({ length: count }, (_: unknown, index: number) => ({
    x: (index % columns) * columnGap - centerX,
    y: Math.floor(index / columns) * rowGap - centerY,
  }));
}

export function computeFitTransform(
  points: LayoutPoint[],
  width: number,
  height: number,
  opts: { padding?: number; nodeRadius?: number; maxScale?: number } = {},
): FitTransform | null {
  const padding = opts.padding ?? 40;
  const r = opts.nodeRadius ?? 20;
  const maxScale = opts.maxScale ?? 2;
  if (points.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    // 防御非有限坐标（模拟在极端参数下可能产生 NaN）
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  }
  if (minX === Infinity) return null;

  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const scale = Math.min(
    (width - padding * 2) / graphWidth,
    (height - padding * 2) / graphHeight,
    maxScale,
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    scale,
    tx: width / 2 - centerX * scale,
    ty: height / 2 - centerY * scale,
  };
}
