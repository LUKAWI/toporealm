<script lang="ts">
  // 星空画布 — 与 Super Plumber 参考实现同构的交互契约（见 ./GraphCanvas.interaction.md）。
  // TopoRealm 语义差异：星体色彩表达对象 kind/模块 presentation（无工作流状态）；
  // 关系方向用不对称渐隐 + 方向折角表达；视图状态（缩放/平移/坐标/选择）从不写入 Core。
  import { onDestroy, onMount } from "svelte";
  import * as d3 from "d3";
  import { store } from "./store.svelte";
  import { computeFitTransform, isUserViewportInput, seedGridLayout } from "./layout";
  import { kindColorOf } from "./moduleProjection";
  import type { GraphObject, GraphRelation } from "./protocol";

  type SimNode = GraphObject & d3.SimulationNodeDatum;
  // Omit 避免与 GraphRelation 的 string 端点交叉成 never
  type SimEdge = Omit<GraphRelation, "source" | "target"> & { source: SimNode | string; target: SimNode | string };

  const NODE_R = 20;

  let svgEl: SVGSVGElement;
  let wrapperEl: HTMLDivElement;
  let tooltipEl: HTMLDivElement;
  let dustEl: SVGSVGElement;
  let simulation: d3.Simulation<SimNode, undefined> | null = null;
  let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  let zoomGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let middlePanPointerId: number | null = null;
  let middlePanPoint: { x: number; y: number } | null = null;

  const prefersReducedMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
  const ENTER_DURATION = prefersReducedMotion ? 0 : 400;

  // ── 中键平移（pointer seam）：d3-zoom 只管滚轮/双击/触控，中键由 pointer 事件接管 ──
  function isMiddleMousePointer(event: PointerEvent): boolean {
    // button 是手势契约；仅排除明确的 touch，避免把触控误当成中键
    return event.button === 1 && event.pointerType !== "touch";
  }

  function endMiddlePan(pointerId: number | null = null): void {
    if (middlePanPointerId === null) return;
    if (pointerId !== null && pointerId !== middlePanPointerId) return;
    const activePointerId = middlePanPointerId;
    middlePanPointerId = null;
    middlePanPoint = null;
    if (svgEl && typeof svgEl.releasePointerCapture === "function") {
      try {
        svgEl.releasePointerCapture(activePointerId);
      } catch {
        // capture 可能已由浏览器自动释放；状态必须清空，避免下一次手势被卡住
      }
    }
    if (svgEl) svgEl.style.cursor = "grab";
  }

  function startMiddlePan(event: PointerEvent): void {
    if (!svgEl || !zoomBehavior || !isMiddleMousePointer(event)) return;
    if (middlePanPointerId !== null) return;
    // 中键开始时取消仍在进行的自动取景，避免 fit transition 覆盖用户手势
    d3.select(svgEl).interrupt();
    middlePanPointerId = event.pointerId;
    middlePanPoint = { x: event.clientX, y: event.clientY };
    if (typeof svgEl.setPointerCapture === "function") {
      try {
        svgEl.setPointerCapture(event.pointerId);
      } catch {
        // 指针已失活时浏览器拒绝 capture；window 级结束监听仍会兜底
      }
    }
    svgEl.style.cursor = "grabbing";
    event.preventDefault();
  }

  function moveMiddlePan(event: PointerEvent): void {
    if (middlePanPointerId !== event.pointerId || !middlePanPoint || !svgEl || !zoomBehavior) return;
    const dx = event.clientX - middlePanPoint.x;
    const dy = event.clientY - middlePanPoint.y;
    middlePanPoint = { x: event.clientX, y: event.clientY };
    if (dx === 0 && dy === 0) return;
    // 程序化 transform 没有 sourceEvent；显式记录用户已接管视角，fit 不再抢取景
    userMovedView = true;
    const current = d3.zoomTransform(svgEl);
    const next = d3.zoomIdentity.translate(current.x + dx, current.y + dy).scale(current.k);
    d3.select(svgEl).call(zoomBehavior.transform, next);
    event.preventDefault();
  }

  // ── 位置缓存（按图分桶）与 fit 管线 ──
  const positionsByGraph = new Map<string, Map<string, { x: number; y: number }>>();
  function positionsFor(graphId: string): Map<string, { x: number; y: number }> {
    let bucket = positionsByGraph.get(graphId);
    if (!bucket) {
      bucket = new Map();
      positionsByGraph.set(graphId, bucket);
    }
    return bucket;
  }
  let currentGraphId = "";
  let currentPositions: Map<string, { x: number; y: number }> = new Map();

  let fitDone = false;
  let fitFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let userMovedView = false;
  let lastRenderSignature: string | null = null;

  let currentNodes: SimNode[] = [];
  let currentEdges: SimEdge[] = [];

  function getContainerSize(): { w: number; h: number } {
    return { w: wrapperEl?.clientWidth || 960, h: wrapperEl?.clientHeight || 680 };
  }

  /** 当前快照中可见的 kind 集合（驱动 halo 渐变 defs 重建）。 */
  function kindColorFor(kind: string): string {
    return kindColorOf(kind, store.moduleStatus);
  }

  /** 深拷贝无关的稳定序列化（内容变化判定；属性顺序不制造假更新）。 */
  function stableKey(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`).join(",")}}`;
  }

  function nodeContentKey(objects: GraphObject[]): string {
    return stableKey(objects.map((object) => ({ id: object.id, kind: object.kind, label: object.label })));
  }

  function edgeContentKey(relations: GraphRelation[]): string {
    return stableKey([...relations].sort((a, b) => a.id.localeCompare(b.id)));
  }

  // ── 过滤（搜索 + kind）与选择着色 ──
  function nodeMatchesFilters(node: GraphObject): boolean {
    const kind = store.kindFilter.trim();
    if (kind && node.kind !== kind) return false;
    const query = store.searchQuery.trim().toLowerCase();
    if (!query) return true;
    return `${node.id} ${node.kind} ${node.label}`.toLowerCase().includes(query);
  }

  function relationMatchesFilters(relation: SimEdge): boolean {
    const source = currentNodes.find((node) => node.id === (typeof relation.source === "object" ? relation.source.id : relation.source));
    const target = currentNodes.find((node) => node.id === (typeof relation.target === "object" ? relation.target.id : relation.target));
    if (!source || !target) return false;
    if (!nodeMatchesFilters(source) || !nodeMatchesFilters(target)) return false;
    const query = store.searchQuery.trim().toLowerCase();
    if (!query) return true;
    return `${relation.id} ${relation.kind} ${relation.label ?? ""} ${relation.source} ${relation.target}`.toLowerCase().includes(query);
  }

  function applyFiltersAndSelection(): void {
    if (!zoomGroup) return;
    zoomGroup.selectAll<SVGGElement, SimNode>(".nodes > g.node")
      .classed("dimmed", (node) => !nodeMatchesFilters(node))
      .classed("is-selected", (node) => store.selection?.type === "object" && store.selection.id === node.id);
    zoomGroup.selectAll<SVGGElement, SimEdge>(".edges .edge-group")
      .classed("dimmed", (edge) => !relationMatchesFilters(edge))
      .classed("is-selected", (edge) => store.selection?.type === "relation" && store.selection.id === edge.id);
  }

  // ── 星体视觉（V4 棱星正本）：halo 贴芒 + 八向星芒 + 红蓝残像 + 白炽核 ──
  const STAR_SPEC: Record<string, { spike: number; glow: number; core: number }> = {
    default: { spike: 44, glow: 0.7, core: 2.6 },
  };

  function starSpecOf(node: SimNode): { spike: number; glow: number; core: number; s: number } {
    const base = STAR_SPEC[node.kind] ?? STAR_SPEC.default;
    return { ...base, s: NODE_R / 20 };
  }

  function spikePathV(len: number): string {
    const w = Math.max(1, len * 0.041);
    return `M0,${-len} L${w},0 L0,${len} L${-w},0 Z`;
  }
  function spikePathH(len: number): string {
    const w = Math.max(1, len * 0.041);
    return `M${-len},0 L0,${-w} L${len},0 L0,${w} Z`;
  }

  /** 闪烁相位：id 哈希 → 同图每次加载相位一致、星与星去同步 */
  function twinklePhase(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(hash);
  }

  function labelOf(node: SimNode): string {
    return node.label.length > 20 ? `${node.label.slice(0, 18)}…` : node.label;
  }

  function applyStarVisual(selection: d3.Selection<SVGGElement, SimNode, any, any>): void {
    selection.select(".node-hit-area")
      .attr("x", -(NODE_R + 8))
      .attr("y", -(NODE_R + 8))
      .attr("height", (NODE_R + 8) * 2)
      .attr("width", (node) => {
        const labelWidth = Math.max(labelOf(node).length * 6.5, node.kind.length * 5.2);
        return NODE_R + 8 + starSpecOf(node).spike + 12 + labelWidth + 8;
      });
    selection.select(".node-hit").attr("r", NODE_R + 8);
    const L = (node: SimNode) => starSpecOf(node).spike * starSpecOf(node).s;
    selection.select(".star-halo")
      .attr("r", (node) => L(node) * 0.88)
      .attr("fill", (node) => `url(#halo-${cssId(node.kind)})`)
      .style("animation-delay", (node) => `${-(twinklePhase(node.id) % 3600)}ms`);
    selection.select(".star-spikes")
      .attr("opacity", (node) => starSpecOf(node).glow)
      .style("animation-delay", (node) => `${-((twinklePhase(node.id) * 7) % 5200)}ms`);
    selection.selectAll<SVGPathElement, SimNode>(".spike-v,.prism-v")
      .attr("d", (node) => spikePathV(L(node)));
    selection.selectAll<SVGPathElement, SimNode>(".spike-h,.prism-h")
      .attr("d", (node) => spikePathH(L(node)));
    selection.selectAll<SVGPathElement, SimNode>(".spike-d1,.spike-d2")
      .attr("d", (node) => spikePathV(L(node) * 0.565));
    selection.select(".prism-r")
      .style("animation-delay", (node) => `${-((twinklePhase(node.id) * 3) % 2200)}ms`);
    selection.select(".prism-b")
      .style("animation-delay", (node) => `${-((twinklePhase(node.id) * 3) % 2200 + 1100)}ms`);
    selection.select(".star-core")
      .attr("r", (node) => starSpecOf(node).core * starSpecOf(node).s)
      .style("animation-delay", (node) => `${-((twinklePhase(node.id) * 13) % 2800)}ms`);
    selection.select(".hover-flash").attr("r", (node) => L(node) * 1.1);
    selection.select(".hover-ring").attr("r", (node) => L(node) * 0.95);
    selection.select(".node-label").attr("x", (node) => L(node) + 12);
    selection.select(".kind-label")
      .attr("x", (node) => L(node) + 12)
      .attr("y", 12);
  }

  function cssId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // ── 关系视觉：E1 渐隐星座线（directed 不对称 + 方向折角；undirected 对称）──
  function edgeEndId(end: SimNode | string): string {
    return typeof end === "object" ? end.id : end;
  }

  function isDirected(edge: SimEdge): boolean {
    return edge.direction !== "undirected";
  }

  function edgeWidthOf(edge: SimEdge, zoomCompensation = edgeZoomW): number {
    void edge;
    return 1.5 * zoomCompensation;
  }

  let edgeZoomW = 1;
  let lastAppliedZoomW = 1;

  function syncEdgeZoomWidth(k: number): void {
    const w = Math.min(2.2, Math.max(1, 1 / Math.sqrt(k)));
    if (Math.abs(w - lastAppliedZoomW) < 0.03) {
      edgeZoomW = lastAppliedZoomW;
      return;
    }
    edgeZoomW = w;
    lastAppliedZoomW = w;
    zoomGroup?.selectAll<SVGLineElement, SimEdge>(".edges .edge-line")
      .attr("stroke-width", (edge) => edgeWidthOf(edge));
  }

  function applyEdgeVisual(selection: d3.Selection<SVGGElement, SimEdge, any, any>): void {
    selection.select<SVGLinearGradientElement>("linearGradient.edge-grad").each(function (this: SVGLinearGradientElement, edge: SimEdge) {
      const gradient = d3.select(this);
      gradient.selectAll("stop").remove();
      const source = currentNodes.find((node) => node.id === edgeEndId(edge.source));
      const color = "#ffffff";
      if (isDirected(edge)) {
        // 方向感：源端亮 → 目标端渐隐（方向折角承担精确指向）
        gradient.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.5);
        gradient.append("stop").attr("offset", "55%").attr("stop-color", color).attr("stop-opacity", 0.34);
        gradient.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0.08);
      } else {
        gradient.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0);
        gradient.append("stop").attr("offset", "10%").attr("stop-color", color).attr("stop-opacity", 0.35);
        gradient.append("stop").attr("offset", "90%").attr("stop-color", color).attr("stop-opacity", 0.35);
        gradient.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
      }
      const sx = source?.x ?? 0;
      const sy = source?.y ?? 0;
      gradient.attr("x1", sx).attr("y1", sy);
    });
    selection.select<SVGLineElement>(".edge-line")
      .attr("stroke", (edge) => `url(#eg-${cssId(edge.id)})`)
      .attr("stroke-width", (edge) => edgeWidthOf(edge))
      .attr("stroke-opacity", 1);
    selection.select<SVGLineElement>(".edge-hit")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12)
      .attr("stroke-opacity", 1)
      .style("pointer-events", "stroke");
  }

  /** 方向折角：directed 关系在 72% 处画一个指向目标的小折角（无 SVG marker 数学）。 */
  function directionChevronPath(sx: number, sy: number, tx: number, ty: number): string {
    const t = 0.72;
    const px = sx + (tx - sx) * t;
    const py = sy + (ty - sy) * t;
    const angle = Math.atan2(ty - sy, tx - sx);
    const size = 7;
    const leftX = px - size * Math.cos(angle - Math.PI / 5);
    const leftY = py - size * Math.sin(angle - Math.PI / 5);
    const rightX = px - size * Math.cos(angle + Math.PI / 5);
    const rightY = py - size * Math.sin(angle + Math.PI / 5);
    return `M${leftX.toFixed(1)},${leftY.toFixed(1)} L${px.toFixed(1)},${py.toFixed(1)} L${rightX.toFixed(1)},${rightY.toFixed(1)}`;
  }

  // ── 边层 ──
  function renderEdgeLayer(
    parent: d3.Selection<SVGGElement, unknown, null, undefined>,
    edges: SimEdge[],
  ): void {
    let linkGroup = parent.select<SVGGElement>(".edges");
    if (linkGroup.empty()) linkGroup = parent.append("g").attr("class", "edges");

    const link = linkGroup
      .selectAll<SVGGElement, SimEdge>("g.edge-group")
      .data(edges, (edge) => edge.id);

    link.exit().remove();

    const enter = link.enter()
      .append("g")
      .attr("class", "edge-group")
      .style("cursor", "pointer");

    enter.append("linearGradient")
      .attr("class", "edge-grad")
      .attr("id", (edge) => `eg-${cssId(edge.id)}`)
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("x1", 0).attr("y1", 0).attr("x2", 1).attr("y2", 0);
    enter.append("line").attr("class", "edge-line");
    enter.append("path").attr("class", "edge-dir")
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.6)")
      .attr("stroke-width", 1.2)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round");
    // 透明加宽命中线：可见线仅 1.5px 极难点中，命中域扩到 12 个图形单位
    enter.append("line").attr("class", "edge-hit");
    enter.append("text").attr("class", "edge-label");

    const all = enter.merge(link);
    applyEdgeVisual(all);
    // 方向折角可见性在创建时即落位（路径几何由 tick 逐帧填充）
    all.select(".edge-dir").attr("opacity", (edge) => (isDirected(edge) ? 1 : 0));

    all.select(".edge-label")
      .attr("text-anchor", "middle")
      .attr("font-size", "11px")
      .style("font-family", "var(--font-sans)")
      .attr("fill", "rgba(255, 255, 255, 0.92)")
      .attr("paint-order", "stroke")
      .attr("stroke", "#000000")
      .attr("stroke-width", "3px")
      .attr("stroke-linejoin", "round")
      .attr("opacity", 0)
      .text((edge) => edge.label ?? edge.kind);

    all
      .on("mouseenter", (event: MouseEvent, edge: SimEdge) => {
        const group = d3.select(event.currentTarget as SVGGElement);
        group.select(".edge-line").attr("stroke-width", 2.5 * edgeZoomW);
        group.select(".edge-label").attr("opacity", 1);
        const sourceId = edgeEndId(edge.source);
        const targetId = edgeEndId(edge.target);
        parent.selectAll<SVGGElement, SimNode>(".nodes > g.node")
          .filter((node) => node.id === sourceId || node.id === targetId)
          .classed("edge-hilite", true);
        if (tooltipEl && wrapperEl) {
          tooltipEl.textContent = `${sourceId} ${isDirected(edge) ? "→" : "—"} ${targetId} · ${edge.kind}`;
          tooltipEl.style.display = "block";
          const rect = wrapperEl.getBoundingClientRect();
          tooltipEl.style.left = `${event.clientX - rect.left + 12}px`;
          tooltipEl.style.top = `${event.clientY - rect.top - 8}px`;
        }
      })
      .on("mouseleave", (event: MouseEvent, edge: SimEdge) => {
        if (tooltipEl) tooltipEl.style.display = "none";
        const group = d3.select(event.currentTarget as SVGGElement);
        group.select(".edge-line").attr("stroke-width", edgeWidthOf(edge));
        group.select(".edge-label").attr("opacity", 0);
        const sourceId = edgeEndId(edge.source);
        const targetId = edgeEndId(edge.target);
        parent.selectAll<SVGGElement, SimNode>(".nodes > g.node")
          .filter((node) => node.id === sourceId || node.id === targetId)
          .classed("edge-hilite", false);
      })
      .on("click", (event: MouseEvent, edge: SimEdge) => {
        event.stopPropagation();
        store.select({ type: "relation", id: edge.id });
      });
  }

  // ── 节点层 ──
  function renderNodeLayer(
    parent: d3.Selection<SVGGElement, unknown, null, undefined>,
    nodes: SimNode[],
  ): void {
    let nodeGroup = parent.select<SVGGElement>(".nodes");
    if (nodeGroup.empty()) nodeGroup = parent.append("g").attr("class", "nodes");

    const node = nodeGroup
      .selectAll<SVGGElement, SimNode>("g.node")
      .data(nodes, (item) => item.id);

    node.exit().remove();

    const enter = node.enter().append("g")
      .attr("class", "node")
      .style("cursor", "pointer")
      .attr("tabindex", 0)
      .attr("role", "button");

    enter.append("rect").attr("class", "node-hit-area").attr("fill", "transparent").attr("rx", 6);
    enter.append("circle").attr("class", "node-hit").attr("fill", "transparent");
    const sky = enter.append("g").attr("class", "star-sky");
    sky.append("circle").attr("class", "star-halo");
    sky.append("circle").attr("class", "hover-flash").attr("fill", "url(#flash-grad)");
    sky.append("circle").attr("class", "hover-ring")
      .attr("fill", "none").attr("stroke", "#ffffff").attr("stroke-width", 1).attr("stroke-opacity", 0.9);
    const ghostSpecs = [
      { cls: "prism-r", color: "#e5504f", offV: "translate(0.8,0)", offH: "translate(0,-0.8)" },
      { cls: "prism-b", color: "#4a93e8", offV: "translate(-0.8,0)", offH: "translate(0,0.8)" },
    ] as const;
    for (const ghost of ghostSpecs) {
      const ghostGroup = sky.append("g").attr("class", ghost.cls).attr("fill", ghost.color).attr("opacity", 0.5);
      ghostGroup.append("path").attr("class", "prism-v").attr("transform", ghost.offV);
      ghostGroup.append("path").attr("class", "prism-h").attr("transform", ghost.offH);
    }
    const spikes = sky.append("g").attr("class", "star-spikes");
    spikes.append("path").attr("class", "spike-v").attr("fill", (node: SimNode) => `url(#spike-v-${cssId(node.kind)})`);
    spikes.append("path").attr("class", "spike-h").attr("fill", (node: SimNode) => `url(#spike-h-${cssId(node.kind)})`);
    spikes.append("path").attr("class", "spike-d1").attr("transform", "rotate(45)")
      .attr("fill", "rgba(255,255,255,0.95)").attr("fill-opacity", 0.55);
    spikes.append("path").attr("class", "spike-d2").attr("transform", "rotate(-45)")
      .attr("fill", "rgba(255,255,255,0.95)").attr("fill-opacity", 0.55);
    sky.append("circle").attr("class", "star-core").attr("fill", "#ffffff");
    enter.append("text").attr("class", "node-label");
    enter.append("text").attr("class", "kind-label");

    const all = enter.merge(node);

    all.select(".node-label")
      .text(labelOf)
      .attr("text-anchor", "start")
      .attr("dominant-baseline", "central")
      .style("font-family", "var(--font-sans)")
      .attr("font-size", "11px")
      .attr("font-weight", "500")
      .attr("fill", (node) => kindColorFor(node.kind))
      .attr("paint-order", "stroke")
      .attr("stroke", "#000000")
      .attr("stroke-width", "3px")
      .attr("stroke-linejoin", "round")
      .style("pointer-events", "none")
      .style("user-select", "none");

    all.select(".kind-label")
      .text((node) => node.kind)
      .attr("text-anchor", "start")
      .style("font-family", "var(--font-mono)")
      .attr("font-size", "9px")
      .attr("fill", "var(--ink-faint)")
      .attr("paint-order", "stroke")
      .attr("stroke", "#000000")
      .attr("stroke-width", "3px")
      .attr("stroke-linejoin", "round")
      .style("pointer-events", "none")
      .style("user-select", "none");

    applyStarVisual(all);

    all
      .attr("aria-label", (node) => `${node.label}（${node.kind}）`)
      .on("keydown", function (event: KeyboardEvent, node: SimNode) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          store.select({ type: "object", id: node.id });
        }
      })
      .on("focus", function (this: SVGGElement) {
        d3.select(this).classed("is-focused", true);
      })
      .on("blur", function (this: SVGGElement) {
        d3.select(this).classed("is-focused", false);
      })
      .on("mouseenter", function (this: SVGGElement, event: MouseEvent, node: SimNode) {
        if (node.label.length > 20 && tooltipEl && wrapperEl) {
          const rect = wrapperEl.getBoundingClientRect();
          tooltipEl.textContent = node.label;
          tooltipEl.style.display = "block";
          tooltipEl.style.left = `${event.clientX - rect.left + 12}px`;
          tooltipEl.style.top = `${event.clientY - rect.top - 8}px`;
        }
        d3.select(this).select(".node-label").attr("opacity", 1);
      })
      .on("mouseleave", function (this: SVGGElement) {
        if (tooltipEl) tooltipEl.style.display = "none";
      })
      .on("click", (event: MouseEvent, node: SimNode) => {
        event.stopPropagation();
        store.select({ type: "object", id: node.id });
      });

    // 拖拽（位置写入缓存；视图状态，不触发 Core 写入）
    const drag = d3.drag<SVGGElement, SimNode>()
      .on("start", function (this: SVGGElement, event, node) {
        if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
        node.fx = node.x;
        node.fy = node.y;
        currentPositions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
        d3.select(this).classed("is-dragging", true);
      })
      .on("drag", (_event, node) => {
        node.fx = _event.x;
        node.fy = _event.y;
        currentPositions.set(node.id, { x: _event.x, y: _event.y });
      })
      .on("end", function (this: SVGGElement, event, node) {
        if (!event.active && simulation) simulation.alphaTarget(0);
        node.fx = null;
        node.fy = null;
        currentPositions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
        d3.select(this).classed("is-dragging", false);
      });
    all.call(drag as never);
  }

  // ── 微尘氛围层（屏幕固定，不随缩放平移）──
  function buildDust(): void {
    if (!dustEl || !wrapperEl) return;
    const w = Math.max(320, wrapperEl.clientWidth || 960);
    const h = Math.max(240, wrapperEl.clientHeight || 680);
    const dust = d3.select(dustEl);
    dust.selectAll("*").remove();
    dust.attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio", "xMidYMid slice");
    const layer = dust.append("g");
    const count = Math.min(120, Math.max(30, Math.round((w * h) / 18000)));
    for (let i = 0; i < count; i++) {
      const r = Math.random() < 0.7 ? 0.5 + Math.random() * 0.5 : 1.0 + Math.random() * 0.4;
      const twinkle = Math.random() < 0.2;
      const circle = layer.append("circle")
        .attr("cx", (Math.random() * w).toFixed(1))
        .attr("cy", (Math.random() * h).toFixed(1))
        .attr("r", r.toFixed(2))
        .attr("class", twinkle ? "dust dust-tw" : "dust");
      if (twinkle) circle.style("animation-delay", `${(-Math.random() * 4.5).toFixed(2)}s`);
    }
  }

  // ── 适应视图与缩放命令 ──
  function autoFit(): void {
    if (!svgEl || !zoomBehavior) return;
    const { w, h } = getContainerSize();
    const points = currentNodes.filter((node) => node.x !== undefined && node.y !== undefined) as { x: number; y: number }[];
    const fit = computeFitTransform(points, w, h, { nodeRadius: NODE_R + 8, padding: 48 });
    if (!fit) return;
    d3.select(svgEl)
      .transition().duration(prefersReducedMotion ? 0 : 500)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(fit.tx, fit.ty).scale(fit.scale));
  }

  function zoomIn(): void {
    if (!svgEl || !zoomBehavior) return;
    d3.select(svgEl).transition().duration(300).call(zoomBehavior.scaleBy, 1.3);
  }

  function zoomOut(): void {
    if (!svgEl || !zoomBehavior) return;
    d3.select(svgEl).transition().duration(300).call(zoomBehavior.scaleBy, 0.7);
  }

  // ── 全量渲染（节点内容变化 / 首次加载）──
  function renderGraph(): void {
    if (!svgEl || !wrapperEl) return;
    const snapshot = store.snapshot;
    if (!snapshot) return;
    const { w, h } = getContainerSize();
    const graphId = snapshot.manifest.id;
    const isGraphSwitch = currentGraphId !== "" && currentGraphId !== graphId;
    currentGraphId = graphId;
    const positions = positionsFor(graphId);
    currentPositions = positions;

    const svg = d3.select(svgEl);
    const previousTransform = (svgEl as SVGSVGElement & { __zoom?: d3.ZoomTransform }).__zoom;
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio", "xMidYMid meet");

    // defs：点阵网格、kind halo/星芒渐变、hover 渐变
    const defs = svg.append("defs");
    defs.append("pattern")
      .attr("id", "dot-grid").attr("width", 20).attr("height", 20)
      .attr("patternUnits", "userSpaceOnUse")
      .append("circle").attr("cx", 10).attr("cy", 10).attr("r", 0.8)
      .attr("fill", "rgba(255, 255, 255, 0.04)");
    const kinds = [...new Set(snapshot.objects.map((object) => object.kind))];
    for (const kind of kinds) {
      const color = kindColorFor(kind);
      const id = cssId(kind);
      const halo = defs.append("radialGradient").attr("id", `halo-${id}`);
      halo.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.5);
      halo.append("stop").attr("offset", "45%").attr("stop-color", color).attr("stop-opacity", 0.11);
      halo.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
      const spikeV = defs.append("linearGradient").attr("id", `spike-v-${id}`).attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
      spikeV.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0);
      spikeV.append("stop").attr("offset", "50%").attr("stop-color", "#ffffff").attr("stop-opacity", 0.85);
      spikeV.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
      const spikeH = defs.append("linearGradient").attr("id", `spike-h-${id}`).attr("x1", 0).attr("y1", 0).attr("x2", 1).attr("y2", 0);
      spikeH.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0);
      spikeH.append("stop").attr("offset", "50%").attr("stop-color", "#ffffff").attr("stop-opacity", 0.85);
      spikeH.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
    }
    const flashGrad = defs.append("radialGradient").attr("id", "flash-grad");
    flashGrad.append("stop").attr("offset", "0%").attr("stop-color", "#ffffff").attr("stop-opacity", 0.85);
    flashGrad.append("stop").attr("offset", "45%").attr("stop-color", "#ffffff").attr("stop-opacity", 0.18);
    flashGrad.append("stop").attr("offset", "100%").attr("stop-color", "#ffffff").attr("stop-opacity", 0);

    svg.append("rect")
      .attr("width", w).attr("height", h)
      .attr("fill", "url(#dot-grid)")
      .attr("class", "grid-bg");

    zoomGroup = svg.append("g").attr("class", "zoom-group");

    if (!zoomBehavior) {
      zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 4])
        // 视图平移由中键 pointer seam 接管；d3-zoom 继续负责滚轮、双击和触控
        .filter((event: Event) => event.type === "wheel" || event.type === "dblclick" || event.type === "touchstart")
        .on("zoom", (event) => {
          if (zoomGroup) zoomGroup.attr("transform", event.transform);
          if (isUserViewportInput(event.sourceEvent as Event | undefined)) userMovedView = true;
          const gridOpacity = Math.min(1, event.transform.k * 1.5);
          svg.select(".grid-bg").attr("opacity", gridOpacity);
          syncEdgeZoomWidth(event.transform.k);
        });
    }
    svg.call(zoomBehavior)
      .on("dblclick.zoom", () => {
        svg.transition().duration(prefersReducedMotion ? 0 : 500)
          .call(zoomBehavior!.transform, d3.zoomIdentity);
      })
      .style("cursor", "grab");
    svg
      .on("pointerdown.middle-pan", startMiddlePan)
      .on("pointermove.middle-pan", moveMiddlePan)
      .on("pointerup.middle-pan", (event: PointerEvent) => endMiddlePan(event.pointerId))
      .on("pointercancel.middle-pan", (event: PointerEvent) => endMiddlePan(event.pointerId))
      .on("pointerleave.middle-pan", (event: PointerEvent) => endMiddlePan(event.pointerId))
      .on("lostpointercapture.middle-pan", (event: PointerEvent) => endMiddlePan(event.pointerId));
    if (previousTransform && !isGraphSwitch) {
      zoomGroup.attr("transform", previousTransform as unknown as string);
    }

    // 节点（位置缓存种子；确定性网格兜底）
    const seed = seedGridLayout(snapshot.objects.length);
    const bySeed = new Map(snapshot.objects.map((object, index) => [object.id, seed[index]]));
    const nodes: SimNode[] = snapshot.objects.map((object) => {
      const cached = positions.get(object.id);
      const base = cached ?? bySeed.get(object.id) ?? { x: 0, y: 0 };
      return { ...object, x: base.x, y: base.y };
    });
    const presentIds = new Set(nodes.map((node) => node.id));
    const edges: SimEdge[] = snapshot.relations
      .filter((relation) => presentIds.has(relation.source) && presentIds.has(relation.target))
      .map((relation) => ({ ...relation })) as SimEdge[];

    currentNodes = nodes;
    currentEdges = edges;

    simulation?.stop();
    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink<SimNode, SimEdge>(edges).id((node) => node.id).distance(160))
      .force("charge", d3.forceManyBody().strength(-Math.min(800, 300 + nodes.length * 25)))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collision", d3.forceCollide<SimNode>().radius(NODE_R + 8))
      .alphaDecay(0.02);

    renderEdgeLayer(zoomGroup, edges);
    renderNodeLayer(zoomGroup, nodes);
    applyFiltersAndSelection();
    syncEdgeZoomWidth((svgEl as SVGSVGElement & { __zoom?: d3.ZoomTransform }).__zoom?.k ?? 1);

    if (!prefersReducedMotion && !isGraphSwitch) {
      zoomGroup.selectAll<SVGGElement, SimNode>(".nodes > g.node")
        .attr("opacity", 0)
        .transition().delay((_node, index) => Math.min(index, 40) * 15).duration(ENTER_DURATION)
        .ease(d3.easeCubicOut)
        .attr("opacity", 1);
    }

    // tick：位置/渐变/折角逐帧同步；fit 挂接模拟收敛
    const edgeSel = zoomGroup.selectAll<SVGGElement, SimEdge>(".edges .edge-group");
    const nodeSel = zoomGroup.selectAll<SVGGElement, SimNode>(".nodes > g.node");
    const updateRender = () => {
      edgeSel.each(function (this: SVGGElement, edge: SimEdge) {
        const group = d3.select(this);
        const source = typeof edge.source === "object" ? edge.source : null;
        const target = typeof edge.target === "object" ? edge.target : null;
        const sx = source?.x ?? 0;
        const sy = source?.y ?? 0;
        const tx = target?.x ?? 0;
        const ty = target?.y ?? 0;
        group.select(".edge-line").attr("x1", sx).attr("y1", sy).attr("x2", tx).attr("y2", ty);
        group.select(".edge-hit").attr("x1", sx).attr("y1", sy).attr("x2", tx).attr("y2", ty);
        group.select(".edge-grad").attr("x1", sx).attr("y1", sy).attr("x2", tx).attr("y2", ty);
        if (isDirected(edge)) {
          group.select(".edge-dir").attr("d", directionChevronPath(sx, sy, tx, ty)).attr("opacity", 1);
        } else {
          group.select(".edge-dir").attr("opacity", 0);
        }
        if (group.select<SVGTextElement>(".edge-label").attr("opacity") !== "0") {
          group.select(".edge-label").attr("x", (sx + tx) / 2).attr("y", (sy + ty) / 2 - 5);
        }
      });
      nodeSel.attr("transform", (node) => `translate(${node.x ?? 0},${node.y ?? 0})`);

      if (!fitDone && simulation && simulation.alpha() <= 0.3) {
        fitDone = true;
        autoFit();
      }
    };
    simulation.on("tick", updateRender);
    simulation.on("end", () => {
      for (const node of nodes) {
        if (node.x !== undefined && node.y !== undefined) positions.set(node.id, { x: node.x, y: node.y });
      }
      if (!userMovedView) autoFit();
    });

    if (fitFallbackTimer) clearTimeout(fitFallbackTimer);
    fitDone = false;
    if (nodes.length > 0) {
      fitFallbackTimer = setTimeout(() => {
        if (!fitDone) {
          fitDone = true;
          autoFit();
        }
      }, 4000);
    }
  }

  /** 仅关系变化：增量更新边层，不重启模拟（保留用户视角与位置）。 */
  function syncEdges(): void {
    if (!svgEl || !zoomGroup || !simulation) {
      renderGraph();
      return;
    }
    const snapshot = store.snapshot;
    if (!snapshot) return;
    const newNodeIds = new Set(snapshot.objects.map((object) => object.id));
    const sameNodes = currentNodes.length === snapshot.objects.length
      && currentNodes.every((node) => newNodeIds.has(node.id))
      && nodeContentKey(currentNodes) === nodeContentKey(snapshot.objects);
    if (!sameNodes) {
      renderGraph();
      return;
    }
    const presentIds = new Set(snapshot.objects.map((object) => object.id));
    const edges: SimEdge[] = snapshot.relations
      .filter((relation) => presentIds.has(relation.source) && presentIds.has(relation.target))
      .map((relation) => ({ ...relation })) as SimEdge[];
    currentEdges = edges;
    renderEdgeLayer(zoomGroup, edges);
    simulation.force("link", d3.forceLink<SimNode, SimEdge>(edges).id((node) => node.id).distance(160));
    simulation.alpha(0.3).restart();
    applyFiltersAndSelection();
  }

  // ── 数据流：内容变化决定全量重建 or 增量同步 ──
  let lastNodeKey: string | null = null;
  let lastEdgeKey: string | null = null;
  $effect(() => {
    const snapshot = store.snapshot;
    if (!snapshot || !svgEl) return;
    const nodeKey = nodeContentKey(snapshot.objects);
    const edgeKey = edgeContentKey(snapshot.relations);
    const identityChanged = snapshot.manifest.id !== currentGraphId;
    const nodeChanged = lastNodeKey !== null && nodeKey !== lastNodeKey;
    const edgeChanged = lastEdgeKey !== null && edgeKey !== lastEdgeKey;
    const isFirst = lastNodeKey === null;
    lastNodeKey = nodeKey;
    lastEdgeKey = edgeKey;
    if (isFirst || identityChanged || nodeChanged) renderGraph();
    else if (edgeChanged) syncEdges();
  });

  // 模块 presentation 变化 → 重刷星体与渐变
  $effect(() => {
    void store.moduleStatus;
    if (!zoomGroup || !store.snapshot) return;
    const svg = d3.select(svgEl);
    const defs = svg.select("defs");
    if (defs.empty()) return;
    for (const kind of new Set(store.objects.map((object) => object.kind))) {
      const color = kindColorFor(kind);
      const id = cssId(kind);
      const halo = defs.select(`#halo-${id}`);
      if (!halo.empty()) {
        halo.selectAll("stop").remove();
        halo.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", 0.5);
        halo.append("stop").attr("offset", "45%").attr("stop-color", color).attr("stop-opacity", 0.11);
        halo.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", 0);
      }
    }
    applyStarVisual(zoomGroup.selectAll<SVGGElement, SimNode>(".nodes > g.node"));
    zoomGroup.selectAll<SVGGElement, SimNode>(".nodes > g.node").select(".node-label")
      .attr("fill", (node) => kindColorFor(node.kind));
    applyEdgeVisual(zoomGroup.selectAll<SVGGElement, SimEdge>(".edges .edge-group"));
  });

  // 选择与过滤变化 → 增量着色
  $effect(() => {
    void store.selection;
    void store.searchQuery;
    void store.kindFilter;
    applyFiltersAndSelection();
  });

  // 工具轨缩放命令
  $effect(() => {
    const request = store.zoomRequest;
    if (!request) return;
    if (request.kind === "in") zoomIn();
    else if (request.kind === "out") zoomOut();
    else if (request.kind === "fit") autoFit();
  });

  // 定位请求（搜索 Enter 等）：平移居中到目标节点
  $effect(() => {
    const request = store.locateRequest;
    if (!request || !svgEl || !zoomBehavior) return;
    const node = currentNodes.find((candidate) => candidate.id === request.nodeId);
    if (!node || node.x === undefined || node.y === undefined) return;
    const { w, h } = getContainerSize();
    const k = (svgEl as SVGSVGElement & { __zoom?: d3.ZoomTransform }).__zoom?.k ?? 1;
    d3.select(svgEl)
      .transition().duration(prefersReducedMotion ? 0 : 450).ease(d3.easeCubicOut)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-node.x, -node.y));
  });

  // Tab 分组循环：焦点只在可见星体间循环
  function canvasKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const active = document.activeElement as HTMLElement | null;
    if (!active?.classList.contains("node")) return;
    event.preventDefault();
    const group = Array.from(wrapperEl?.querySelectorAll<HTMLElement>("g.node:not(.dimmed)") ?? []);
    if (group.length === 0) return;
    const index = group.indexOf(active);
    const next = group[(index + (event.shiftKey ? -1 : 1) + group.length) % group.length];
    next?.focus();
  }

  let resizeObserver: ResizeObserver | null = null;
  let resizeFitTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    if (!wrapperEl) return;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (!store.snapshot || !svgEl) return;
        const { w, h } = getContainerSize();
        d3.select(svgEl).attr("viewBox", `0 0 ${w} ${h}`);
        if (resizeFitTimer) clearTimeout(resizeFitTimer);
        resizeFitTimer = setTimeout(() => {
          fitDone = true;
          autoFit();
        }, 180);
        buildDust();
      });
      resizeObserver.observe(wrapperEl);
    }
    buildDust();

    // 画布空白处点击 = 清除选中（焦点残留一并交还）
    d3.select(svgEl).on("click.bg", (event: MouseEvent) => {
      const target = event.target as Element;
      if (target === svgEl || target.classList?.contains("grid-bg")) {
        if (document.activeElement instanceof Element && document.activeElement.closest("g.node")) {
          (document.activeElement as HTMLElement).blur?.();
        }
        store.select(null);
      }
    });

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomIn();
      } else if (event.key === "-") {
        event.preventDefault();
        zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        autoFit();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    const handlePointerEnd = (event: PointerEvent) => endMiddlePan(event.pointerId);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  });

  onDestroy(() => {
    endMiddlePan();
    simulation?.stop();
    resizeObserver?.disconnect();
    if (fitFallbackTimer) clearTimeout(fitFallbackTimer);
    if (resizeFitTimer) clearTimeout(resizeFitTimer);
  });
</script>

<!-- 键盘分组循环的冒泡容器（可交互焦点都在内部 SVG 上，容器自身不可聚焦） -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={wrapperEl} class="canvas-wrapper" onkeydown={canvasKeydown}>
  <!-- 银河带 + 微尘：屏幕固定层（不随缩放平移） -->
  <div class="sky-bg" aria-hidden="true">
    <div class="sky-band"></div>
    <svg class="sky-dust" bind:this={dustEl}></svg>
  </div>
  <svg bind:this={svgEl} class="graph-canvas"></svg>
  <div bind:this={tooltipEl} class="node-tooltip"></div>

  <div class="zoom-hint">
    <span class="hint-key">scroll</span> 缩放
    <span class="hint-sep">·</span>
    <span class="hint-key">中键拖动</span> 平移
    <span class="hint-sep">·</span>
    <span class="hint-key">双击</span> 重置
    <span class="hint-sep">·</span>
    <span class="hint-key">0</span> 适配
    <span class="hint-sep">·</span>
    <span class="hint-key">Tab</span> 选节点
  </div>
</div>

<style>
  .canvas-wrapper {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--bg);
  }

  /* ── 银河带 + 微尘：屏幕固定层 ── */
  .sky-bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
  }

  .graph-canvas {
    position: relative;
    z-index: 2;
    width: 100%;
    height: 100%;
    display: block;
  }

  .sky-band {
    position: absolute;
    inset: -20%;
    background: linear-gradient(
      162deg,
      transparent 40%,
      rgba(207, 216, 255, 0.05) 49%,
      rgba(232, 236, 255, 0.032) 52%,
      transparent 60%
    );
  }

  .sky-dust {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .node-tooltip {
    position: absolute;
    background: var(--surface-2);
    border: 1px solid var(--line);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--r-sm);
    pointer-events: none;
    display: none;
    z-index: var(--z-tooltip);
    white-space: nowrap;
    letter-spacing: var(--track-label);
  }

  /* 过滤淡化（0.3：保留轮廓可寻）与隐藏 */
  :global(.nodes > g.node.dimmed),
  :global(.edges > g.edge-group.dimmed) {
    opacity: 0.3;
  }

  /* ── 星空节点：V4 棱星正本 + 声呐环 hover（d3 生成 DOM → :global）── */
  :global {
    @keyframes star-breathe {
      0%, 100% { opacity: 0.82; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.06); }
    }
    @keyframes star-sparkle {
      0%, 100% { opacity: 0.9; }
      42% { opacity: 0.55; }
      58% { opacity: 0.95; }
    }
    @keyframes core-glint {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.86; }
    }
    @keyframes prism-shift {
      0%, 100% { transform: translate(0, 0); opacity: 0.5; }
      50% { transform: translate(0.6px, -0.4px); opacity: 0.32; }
    }
    @keyframes ring-bloom {
      0% { opacity: 0.9; transform: scale(0.5); }
      100% { opacity: 0; transform: scale(1.7); }
    }
    @keyframes flash-pulse {
      0% { opacity: 0; }
      18% { opacity: 0.6; }
      100% { opacity: 0; }
    }

    .nodes g.node .star-sky {
      pointer-events: none;
      transform-origin: center;
      transform-box: fill-box;
    }

    /* hover / 焦点 / 选中 / 边高亮：声呐环（单次）+ 白炽脉冲 + 星芒增亮 */
    .nodes g.node .hover-flash {
      opacity: 0;
      transform-origin: center;
      transform-box: fill-box;
    }
    .nodes g.node .hover-ring {
      opacity: 0;
      transform: scale(0.5);
      transform-origin: center;
      transform-box: fill-box;
    }
    .nodes g.node:hover .hover-ring,
    .nodes g.node.is-focused .hover-ring {
      animation: ring-bloom 0.8s var(--ease-out-quart);
    }
    .nodes g.node:hover .hover-flash,
    .nodes g.node.is-focused .hover-flash {
      animation: flash-pulse 0.4s var(--ease-out-quart);
    }
    .nodes g.node:hover .star-spikes,
    .nodes g.node.is-focused .star-spikes,
    .nodes g.node.is-selected .star-spikes,
    .nodes g.node.edge-hilite .star-spikes {
      filter: brightness(1.35);
    }
    .nodes g.node.is-selected .node-label,
    .nodes g.node.is-selected .kind-label {
      fill: var(--ink);
    }
    .nodes g.node.is-dragging {
      cursor: grabbing;
    }

    .nodes g.node .star-halo {
      animation: star-breathe 3.6s ease-in-out infinite;
      transform-origin: center;
      transform-box: fill-box;
    }
    .nodes g.node .star-spikes {
      animation: star-sparkle 5.2s ease-in-out infinite;
      transform-origin: center;
      transform-box: fill-box;
      transition: filter 0.14s var(--ease-out-quart);
    }
    .nodes g.node .star-core {
      animation: core-glint 2.8s ease-in-out infinite;
      transform-origin: center;
      transform-box: fill-box;
    }
    .nodes g.node .prism-r {
      animation: prism-shift 2.2s ease-in-out infinite;
      transform-box: fill-box;
    }
    .nodes g.node .prism-b {
      animation: prism-shift 2.2s ease-in-out -1.1s infinite;
      transform-box: fill-box;
    }

    @media (prefers-reduced-motion: reduce) {
      .nodes g.node .star-halo,
      .nodes g.node .star-spikes,
      .nodes g.node .star-core,
      .nodes g.node .prism-r,
      .nodes g.node .prism-b {
        animation: none;
      }
      .nodes g.node:hover .hover-ring,
      .nodes g.node.is-focused .hover-ring,
      .nodes g.node:hover .hover-flash,
      .nodes g.node.is-focused .hover-flash {
        animation: none;
      }
      .nodes g.node .star-spikes {
        transition: none;
      }
      .sky-dust .dust-tw {
        animation: none;
      }
    }
  }

  /* 键盘焦点：SVG g 不支持 outline，视觉由 JS 焦点环承担 */
  .graph-canvas :global(g.node:focus) {
    outline: none;
  }

  /* 微尘由 d3 生成 → 样式走 :global */
  :global {
    .sky-dust .dust {
      fill: rgba(255, 255, 255, 0.32);
    }
    .sky-dust .dust-tw {
      animation: dust-tw 4.5s ease-in-out infinite;
    }
    @keyframes dust-tw {
      0%, 100% { opacity: 0.14; }
      50% { opacity: 0.5; }
    }
  }

  .zoom-hint {
    position: absolute;
    bottom: var(--sp-4);
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    pointer-events: none;
    background: var(--glass);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    padding: var(--sp-1) var(--sp-3);
    border-radius: 999px;
    border: 1px solid var(--glass-line);
    z-index: 5;
    letter-spacing: 0.02em;
    transition: color 0.2s var(--ease-out-quart);
  }

  .canvas-wrapper:hover .zoom-hint {
    color: var(--ink-muted);
  }

  .hint-key {
    color: var(--ink-muted);
    font-weight: 500;
    font-family: var(--font-mono);
  }

  .hint-sep {
    margin: 0 var(--sp-1);
    color: var(--ink-faint);
  }

  @media (max-width: 1000px) {
    /* 窄屏下底部提示条是桌面 affordance，让位 */
    .zoom-hint { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .zoom-hint { transition: none; }
  }
</style>
