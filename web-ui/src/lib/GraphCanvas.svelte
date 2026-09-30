<script lang="ts">
  // 星空画布 — 与 Super Plumber 参考实现同构的交互契约（见 ./GraphCanvas.interaction.md）。
  // TopoRealm 语义差异：星体色彩表达对象 kind/模块 presentation（无工作流状态）；
  // 关系方向用不对称渐隐 + 方向折角表达；视图状态（缩放/平移/坐标/选择）从不写入 Core。
  import { onDestroy, onMount } from "svelte";
  import * as d3 from "d3";
  import { store } from "./store.svelte";
  import { computeFitTransform, isUserViewportInput, partitionLayoutEdges, seedGridLayout } from "./layout";
  import { fallbackKindColor, kindColorOf, projectModuleKind, type KindRepresent } from "./moduleProjection";
  import { displayOf, titleOf, type Entity, type RelationEntity } from "./protocol";

  type SimNode = Entity & d3.SimulationNodeDatum;
  // Omit 避免与 RelationEntity 的 string 端点交叉成 never
  type SimEdge = Omit<RelationEntity, "source" | "target"> & { source: SimNode | string; target: SimNode | string };

  // ── 语义分层（D46 represent，目录 kinds 声明）──
  // container = 玻璃容器分区（标题 + 成员计数徽章，默认折叠）；annotation = 附属标注
  // （不画星体：恰一宿主 → 宿主角标；零/多宿主 → 右缘附属侧栏；容器成员 → 分区已表达）。
  function representOfKind(kind: string): KindRepresent | undefined {
    return projectModuleKind(kind, store.catalog).represent;
  }

  interface LayeredSemantics {
    containerIds: Set<string>;
    /** 容器 id → 成员对象集合（member_of source；任意 kind，含标注成员） */
    membersOf: Map<string, Entity[]>;
    /** 标注渲染模式：badge=恰一宿主星体；fallback=零/多宿主进侧栏；member=容器成员 */
    annotationModes: Map<string, "badge" | "fallback" | "member">;
    /** 宿主星体 id → 挂靠的标注对象（角标） */
    hostBadges: Map<string, Entity[]>;
    /** 附属侧栏兜底列表（零/多宿主标注） */
    fallbackAnnotations: Entity[];
  }

  /**
   * 宿主判定通用规则：represent=annotation 的对象看它参与的边（member_of → 声明容器的
   * 成员边除外——归属已由容器分区表达）——恰好一条边且另一端是普通星体 → 另一端即宿主；
   * 零条/多条/宿主非星体（容器或标注）→ 附属侧栏兜底。
   */
  function computeLayeredSemantics(objects: readonly Entity[], relations: readonly RelationEntity[]): LayeredSemantics {
    const containerIds = new Set(
      objects.filter((object) => representOfKind(object.kind) === "container").map((object) => object.id),
    );
    const byId = new Map(objects.map((object) => [object.id, object]));
    const membersOf = new Map<string, Entity[]>();
    for (const relation of relations) {
      if (relation.kind !== "member_of" || !containerIds.has(relation.target)) continue;
      const member = byId.get(relation.source);
      if (!member) continue;
      const list = membersOf.get(relation.target);
      if (list) list.push(member);
      else membersOf.set(relation.target, [member]);
    }
    const annotationModes = new Map<string, "badge" | "fallback" | "member">();
    const hostBadges = new Map<string, Entity[]>();
    const fallbackAnnotations: Entity[] = [];
    for (const object of objects) {
      if (representOfKind(object.kind) !== "annotation") continue;
      if (relations.some((relation) => relation.kind === "member_of" && relation.source === object.id && containerIds.has(relation.target))) {
        annotationModes.set(object.id, "member");
        continue;
      }
      const hostEdges = relations.filter(
        (relation) =>
          (relation.source === object.id || relation.target === object.id) &&
          !(relation.kind === "member_of" && containerIds.has(relation.target)),
      );
      const host =
        hostEdges.length === 1
          ? byId.get(hostEdges[0]!.source === object.id ? hostEdges[0]!.target : hostEdges[0]!.source)
          : undefined;
      if (host && representOfKind(host.kind) === undefined) {
        annotationModes.set(object.id, "badge");
        const list = hostBadges.get(host.id);
        if (list) list.push(object);
        else hostBadges.set(host.id, [object]);
      } else {
        annotationModes.set(object.id, "fallback");
        fallbackAnnotations.push(object);
      }
    }
    return { containerIds, membersOf, annotationModes, hostBadges, fallbackAnnotations };
  }

  /** 当前生效的分层语义（画布 d3 渲染与 Svelte 浮层/侧栏共用同一真相） */
  let layered: LayeredSemantics = {
    containerIds: new Set(),
    membersOf: new Map(),
    annotationModes: new Map(),
    hostBadges: new Map(),
    fallbackAnnotations: [],
  };

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
    badgePopup = null; // 平移后宿主屏幕锚点失效，附属浮层收起
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
  // 渲染后布局被用户交互（拖拽星体/容器）重热过 → 模拟收敛时不再自动抢取景。
  // 缺陷③根因：拖拽重热的模拟 ~4.5s 后触发 end 事件 → autoFit 缓动，与用户随后的
  // 空白点击撞车，观感为「点空白引发视图缩放/平移动画」（节点图形坐标并未变化）。
  let touchedLayout = false;
  let lastRenderSignature: string | null = null;

  let currentNodes: SimNode[] = [];
  let currentEdges: SimEdge[] = [];

  function getContainerSize(): { w: number; h: number } {
    return { w: wrapperEl?.clientWidth || 960, h: wrapperEl?.clientHeight || 680 };
  }

  /** 当前快照中可见的 kind 集合（驱动 halo 渐变 defs 重建）。 */
  function kindColorFor(kind: string): string {
    return kindColorOf(kind, store.catalog);
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

  function nodeContentKey(objects: readonly Entity[]): string {
    return stableKey(objects.map((object) => ({ id: object.id, kind: object.kind, title: titleOf(object) })));
  }

  function edgeContentKey(relations: readonly RelationEntity[]): string {
    return stableKey([...relations].sort((a, b) => a.id.localeCompare(b.id)));
  }

  // ── 过滤（搜索 + kind）与选择着色 ──
  function nodeMatchesFilters(node: Entity): boolean {
    const kind = store.kindFilter.trim();
    if (kind && node.kind !== kind) return false;
    const query = store.searchQuery.trim().toLowerCase();
    if (!query) return true;
    return `${node.id} ${node.kind} ${displayOf(node)}`.toLowerCase().includes(query);
  }

  /** 容器成员的当前可见计数（成员被过滤时容器计数同步——同一 nodeMatchesFilters 语义） */
  function memberCountOf(containerId: string): number {
    return (layered.membersOf.get(containerId) ?? []).filter((member) => nodeMatchesFilters(member)).length;
  }

  function relationMatchesFilters(relation: SimEdge): boolean {
    const source = currentNodes.find((node) => node.id === (typeof relation.source === "object" ? relation.source.id : relation.source));
    const target = currentNodes.find((node) => node.id === (typeof relation.target === "object" ? relation.target.id : relation.target));
    if (!source || !target) return false;
    if (!nodeMatchesFilters(source) || !nodeMatchesFilters(target)) return false;
    const query = store.searchQuery.trim().toLowerCase();
    if (!query) return true;
    return `${relation.id} ${relation.kind} ${titleOf(relation)} ${relation.source} ${relation.target}`.toLowerCase().includes(query);
  }

  /** 选中类成员光晕（R4）：实例色 drop-shadow 克制脉动（CSS）；reduced-motion 静态化。 */
  function applyContainerClassGlow(): void {
    if (!zoomGroup) return;
    const selectedId = store.selectedContainerId;
    const members = selectedId
      ? new Set((layered.membersOf.get(selectedId) ?? []).map((member) => member.id))
      : new Set<string>();
    const color = selectedId ? containerColorOf(selectedId) : null;
    zoomGroup
      .selectAll<SVGGElement, SimNode>(".nodes > g.node")
      .classed("is-class-glow", (node) => members.has(node.id))
      .style("--class-glow-color", (node) => (members.has(node.id) ? color : null));
  }

  function applyFiltersAndSelection(): void {
    if (!zoomGroup) return;
    zoomGroup.selectAll<SVGGElement, SimNode>(".nodes > g.node")
      .classed("dimmed", (node) => !nodeMatchesFilters(node))
      .classed("is-selected", (node) => store.selection?.type === "object" && store.selection.id === node.id);
    zoomGroup.selectAll<SVGGElement, SimEdge>(".edges .edge-group")
      .classed("dimmed", (edge) => !relationMatchesFilters(edge))
      .classed("is-selected", (edge) => store.selection?.type === "relation" && store.selection.id === edge.id);
    // 容器计数徽章随过滤同步；容器本体不淡化（结构层），计数即过滤真相
    zoomGroup.selectAll<SVGGElement, SimNode>(".containers > g.container-group").each((node) => {
      applyContainerGeometry(node);
    });
    applyContainerClassGlow();
  }

  // ── 附属标注角标浮层（视图状态，浏览器本地）──
  // 模板侧的响应式语义：从 store 直接派生（d3 渲染用的可变 layered 不进响应式图）
  const reactiveSemantics = $derived(
    store.snapshot ? computeLayeredSemantics(store.snapshot.objects, store.snapshot.relations) : null,
  );
  let badgePopup = $state<{ hostId: string; x: number; y: number } | null>(null);
  const badgePopupItems = $derived(badgePopup ? (reactiveSemantics?.hostBadges.get(badgePopup.hostId) ?? []) : []);
  const fallbackVisible = $derived(
    (reactiveSemantics?.fallbackAnnotations ?? []).filter((annotation) => nodeMatchesFilters(annotation)),
  );
  const affiliatedGroups = $derived.by(() => {
    const byKind = new Map<string, Entity[]>();
    for (const annotation of fallbackVisible) {
      const list = byKind.get(annotation.kind);
      if (list) list.push(annotation);
      else byKind.set(annotation.kind, [annotation]);
    }
    return [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  $effect(() => {
    // 快照/关系变化后宿主不再有挂靠标注 → 浮层自动收起
    if (badgePopup && badgePopupItems.length === 0) badgePopup = null;
  });

  // 选中对象变化 = 用户已在别处交互，浮层锚定的是旧宿主屏幕坐标 → 随选择变化收起。
  // 只跟踪 selection（不读 badgePopup），弹开浮层本身不会触发本 effect。
  let lastSelectionKey: string | null = null;
  $effect(() => {
    const key = stableKey(store.selection);
    if (lastSelectionKey !== null && key !== lastSelectionKey) badgePopup = null;
    lastSelectionKey = key;
  });

  $effect(() => {
    // 选中容器被删除/切图后失效 → 自动清空（与附属浮层同模式的失效自愈）
    if (store.selectedContainerId && !(reactiveSemantics?.containerIds.has(store.selectedContainerId) ?? false)) {
      store.selectedContainerId = null;
    }
  });

  function openBadgePopup(host: SimNode): void {
    if (!svgEl) return;
    const transform = d3.zoomTransform(svgEl);
    const width = getContainerSize().w;
    // 浮层锚在宿主星体的屏幕坐标上（svg 单位 = wrapper CSS 像素），右缘内收防溢出
    const x = Math.min((host.x ?? 0) * transform.k + transform.x, Math.max(16, width - 250));
    const y = Math.max(16, (host.y ?? 0) * transform.k + transform.y);
    badgePopup = { hostId: host.id, x, y };
  }

  function selectAffiliated(id: string): void {
    badgePopup = null;
    store.select({ type: "object", id }); // 复用 ObjectDetail 详情抽屉
  }

  // 容器展开/收起与选中类（视图状态：默认折叠；浏览器本地，不写 Core）。
  // $state 记录：右上角看板（R2）要响应式读取展开态/选中态，d3 渲染与 HTML 看板共用同一真相。
  let expandedContainers = $state<Record<string, boolean>>({});

  /** 容器实例色（R1）：复用确定性哈希回退色（8 色板）——同 kind 不同实例不同色，kind 色继续归普通星体。 */
  function containerColorOf(containerId: string): string {
    return fallbackKindColor(containerId);
  }

  /** hex → rgba（展开框描边半透明用；回退色板与目录声明色均为 hex）。 */
  function hexAlpha(hex: string, alpha: number): string {
    const value = hex.replace("#", "");
    return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`;
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
    const label = displayOf(node);
    return label.length > 20 ? `${label.slice(0, 18)}…` : label;
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
      .text((edge) => titleOf(edge) || edge.kind);

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

  /**
   * 星体/容器条共用的拖拽行为（位置写入缓存；视图状态，不触发 Core 写入）。
   * 点击/拖拽解耦：d3-drag 在 mousedown 即派发 start（此时无位移信息），若在 start 里
   * 钉住 fx/fy 并重启模拟，纯点击也会扰动整个布局。因此首帧实际位移（drag 事件）才
   * 钉住并唤醒模拟；down→up 之间有任何位移时，d3-drag 默认 clickDistance(0) 会吞掉
   * 后续 click——拖拽不误触点击、点击不扰动布局，两者互不误伤。
   */
  function nodeDragBehavior(): d3.DragBehavior<SVGGElement, SimNode, SimNode | d3.SubjectPosition> {
    // 同一行为实例被整层共享，移动标记按节点记（并发多手势互不串扰）
    const movedNodes = new WeakSet<SimNode>();
    return d3.drag<SVGGElement, SimNode>()
      .on("drag", function (this: SVGGElement, event, node) {
        if (!movedNodes.has(node)) {
          movedNodes.add(node);
          // drag 事件的 active 含当前手势：≤1 说明没有并发其他手势，由本手势唤醒模拟
          if (event.active <= 1 && simulation) simulation.alphaTarget(0.3).restart();
          touchedLayout = true; // 布局被交互重热，收敛后不再自动抢取景（缺陷③）
          if (badgePopup?.hostId === node.id) badgePopup = null; // 宿主位移后浮层锚点失效
          d3.select(this).classed("is-dragging", true);
        }
        node.fx = event.x;
        node.fy = event.y;
        currentPositions.set(node.id, { x: event.x, y: event.y });
      })
      .on("end", function (this: SVGGElement, event, node) {
        // 只在本手势真的拖动过时收尾模拟（纯点击不碰模拟状态）；active 不含已结束的本手势
        if (movedNodes.delete(node) && !event.active && simulation) simulation.alphaTarget(0);
        node.fx = null;
        node.fy = null;
        currentPositions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
        d3.select(this).classed("is-dragging", false);
      });
  }

  // ── 容器层（D46 container）：玻璃分区底板 + 顶层头部条；默认折叠 ──
  // 底板层（.containers，zoomGroup 首层）只承载框体矩形；头部条层（.container-headers，
  // zoomGroup 末层）承载 dot + 标题 + 计数徽章并承担键盘/焦点交互。拆两层是因为成员星体
  // 与其附属角标画在容器层之上：头部条若留在底板层，展开态成员角标会盖住标题并吞掉点击
  // （1.4.1 实测缺陷①）。SVG 无 z-index、文档顺序 = 视觉/命中最上层，分组内提升无效，
  // 头部条必须是独立末层。
  /** 容器局部系几何：折叠 = 固定条；展开 = 成员包围盒 + 内边距（标注成员不入模拟，仅由计数徽章表达）。
   * 组元素已平移到容器星位（tick 的 transform），成员模拟坐标先转到容器局部系再求包围盒——
   * 直接用绝对坐标会把底板平移两次，画到成员簇之外的空白处（1.4.0「框内没有成员」缺陷根因）。
   * 容器自身位置作种子留在盒内，锚点不跳。看板定位（R3）复用同一几何。 */
  function containerBoxOf(node: SimNode): { x: number; y: number; w: number; h: number; barWidth: number } {
    const barWidth = Math.max(132, displayOf(node).length * 7 + 66);
    if (!(expandedContainers[node.id] ?? false)) {
      return { x: -barWidth / 2, y: -18, w: barWidth, h: 36, barWidth };
    }
    const padX = 20;
    const padTop = 46;
    const padBottom = 20;
    const originX = node.x ?? 0;
    const originY = node.y ?? 0;
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const member of layered.membersOf.get(node.id) ?? []) {
      const m = currentNodes.find((candidate) => candidate.id === member.id);
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      const localX = m.x! - originX;
      const localY = m.y! - originY;
      minX = Math.min(minX, localX);
      minY = Math.min(minY, localY);
      maxX = Math.max(maxX, localX);
      maxY = Math.max(maxY, localY);
    }
    return {
      x: minX - padX,
      y: minY - padTop,
      w: Math.max(barWidth, maxX - minX + padX * 2),
      h: Math.max(36, maxY - minY + padTop + padBottom),
      barWidth,
    };
  }

  function applyContainerGeometry(node: SimNode): void {
    if (!zoomGroup) return;
    const expanded = expandedContainers[node.id] ?? false;
    const selected = store.selectedContainerId === node.id;
    const instanceColor = containerColorOf(node.id);
    const group = zoomGroup
      .selectAll<SVGGElement, SimNode>(".containers > g.container-group")
      .filter((item) => item.id === node.id);
    const header = zoomGroup
      .selectAll<SVGGElement, SimNode>(".container-headers > g.container-header")
      .filter((item) => item.id === node.id);
    group.classed("expanded", expanded).classed("collapsed", !expanded).classed("is-selected", selected);
    header
      .classed("expanded", expanded)
      .classed("collapsed", !expanded)
      .classed("is-selected", selected)
      .attr("aria-expanded", expanded);
    // 实例色（R1）经 CSS 变量下放：展开框描边半透明实例色；选中态提亮 + 加粗（CSS 消费）
    if (expanded) group.style("--container-stroke", hexAlpha(instanceColor, 0.55));
    else group.style("--container-stroke", null);
    group.style("--container-stroke-selected", instanceColor);
    const title = displayOf(node);
    const count = memberCountOf(node.id);
    header.select<SVGTextElement>(".container-title").text(title);
    header.select<SVGTextElement>(".container-count").text(String(count));
    header.select<SVGGElement>(".container-badge").classed("empty", count === 0);
    const box = containerBoxOf(node);
    if (!expanded) {
      group.select<SVGRectElement>(".container-body")
        .attr("x", box.x).attr("y", box.y).attr("width", box.w).attr("height", box.h).attr("rx", 12);
      header.select("circle.container-dot").attr("cx", box.x + 16).attr("cy", 0).attr("r", 4);
      header.select<SVGTextElement>(".container-title").attr("x", box.x + 26).attr("y", 0);
      header.select<SVGGElement>(".container-badge").attr("transform", `translate(${box.w / 2 - 16},0)`);
      // 命中区几何同步（展开态才由 CSS 放开 display）：折叠态不抢成员星体的点击
      header.select<SVGRectElement>(".container-header-hit")
        .attr("x", box.x).attr("y", box.y).attr("width", box.w).attr("height", box.h).attr("rx", 12);
      return;
    }
    group.select<SVGRectElement>(".container-body")
      .attr("x", box.x).attr("y", box.y).attr("width", box.w).attr("height", box.h).attr("rx", 14);
    header.select("circle.container-dot").attr("cx", box.x + 16).attr("cy", box.y + 19).attr("r", 4);
    header.select<SVGTextElement>(".container-title").attr("x", box.x + 26).attr("y", box.y + 19);
    header.select<SVGGElement>(".container-badge").attr("transform", `translate(${box.x + box.w - 18},${box.y + 19})`);
    // 展开态命中区 = 框顶行全宽：成员星体/角标与标题重叠时，头部条点击优先（可靠收起）
    header.select<SVGRectElement>(".container-header-hit")
      .attr("x", box.x).attr("y", box.y).attr("width", box.w).attr("height", 38).attr("rx", 14);
  }

  // 容器交互原语（R4/R5）：选中类独占（清节点选中走 store.select 互斥中枢）；
  // 展开入口只在看板——画布折叠条点击仅选中，展开态头部条/框体点击收起。
  function selectContainer(id: string): void {
    store.select(null);
    store.selectedContainerId = id;
  }

  function expandContainer(node: SimNode): void {
    expandedContainers[node.id] = true;
    applyContainerGeometry(node);
  }

  function collapseContainer(node: SimNode): void {
    expandedContainers[node.id] = false;
    applyContainerGeometry(node);
  }

  function toggleContainer(node: SimNode): void {
    if (expandedContainers[node.id] ?? false) collapseContainer(node);
    else expandContainer(node);
  }

  /** 画布侧容器点击（折叠条/展开框体共用）：折叠 = 仅选中（不展开，R5）；展开 = 收起。 */
  function onContainerClick(node: SimNode): void {
    if (expandedContainers[node.id] ?? false) collapseContainer(node);
    else selectContainer(node.id);
  }

  // ── 右上角容器看板（R2/R3/R5）：实例色行 + 计数 + 折叠态 + 展开入口 ──
  // 窄屏（≤768px）收纳为可展开（boardOpen）；宽屏 CSS 强制显示行区。
  let boardOpen = $state(false);

  // 右缘详情抽屉（对象/关系/批注面板共用 DetailDrawer 壳）打开时整栈左移让位，
  // 看板行不再被抽屉盖住（1.4.2 实测缺陷①）；抽屉关闭时回位。
  const drawerOpen = $derived(store.selection !== null || store.composer !== null);

  /** 看板行数据投影：与画布共用 reactiveSemantics/过滤语义/展开态/选中态的同一真相。 */
  const containerRows = $derived.by(() => {
    const semantics = reactiveSemantics;
    const snapshot = store.snapshot;
    if (!semantics || !snapshot) return [];
    const rows = snapshot.objects
      .filter((object) => semantics.containerIds.has(object.id))
      .map((object) => ({
        id: object.id,
        title: displayOf(object),
        kind: object.kind,
        color: containerColorOf(object.id),
        count: (semantics.membersOf.get(object.id) ?? []).filter((member) => nodeMatchesFilters(member)).length,
        expanded: expandedContainers[object.id] ?? false,
        selected: store.selectedContainerId === object.id,
      }));
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return rows;
  });

  /** 看板行点击：选中该类（store.select 中枢互斥清节点选中）+ 平移居中（展开=框中心，折叠=条位置）。 */
  function locateContainerFromBoard(id: string): void {
    store.select(null);
    store.selectedContainerId = id;
    const node = currentNodes.find((candidate) => candidate.id === id);
    if (!node) {
      store.locateNode(id);
      return;
    }
    const box = containerBoxOf(node);
    store.locateNode(id, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
  }

  /** 看板行按钮：折叠类的唯一展开入口 / 展开类收起（与画布头部条共享状态）。 */
  function toggleContainerFromBoard(id: string): void {
    const node = currentNodes.find((candidate) => candidate.id === id);
    if (node) toggleContainer(node);
  }

  /** 底板层（.containers，首层）：只承载框体矩形，点击/拖拽照常（玻璃底板语义）。 */
  function renderContainerLayer(
    parent: d3.Selection<SVGGElement, unknown, null, undefined>,
    containers: SimNode[],
  ): void {
    let group = parent.select<SVGGElement>(".containers");
    if (group.empty()) group = parent.insert("g", ":first-child").attr("class", "containers");

    const container = group
      .selectAll<SVGGElement, SimNode>("g.container-group")
      .data(containers, (item) => item.id);

    container.exit().remove();

    const enter = container.enter().append("g")
      .attr("class", "container-group")
      .style("cursor", "pointer");
    enter.append("rect").attr("class", "container-body");

    enter.merge(container)
      .on("click", (event: MouseEvent, node: SimNode) => {
        event.stopPropagation();
        onContainerClick(node);
      })
      .call(nodeDragBehavior());
  }

  /**
   * 头部条层（.container-headers，zoomGroup 末层）：dot + 标题 + 计数徽章 + 键盘/焦点交互。
   * 必须在星体层之后渲染（文档顺序 = 视觉/命中最上层），展开态压过成员星体的附属角标。
   * 命中区 rect 只在展开态放开（CSS display）：覆盖框顶行，标题与角标重叠时点击优先落头部条。
   */
  function renderContainerHeaderLayer(
    parent: d3.Selection<SVGGElement, unknown, null, undefined>,
    containers: SimNode[],
  ): void {
    let layer = parent.select<SVGGElement>(".container-headers");
    if (layer.empty()) layer = parent.append("g").attr("class", "container-headers");

    const header = layer
      .selectAll<SVGGElement, SimNode>("g.container-header")
      .data(containers, (item) => item.id);

    header.exit().remove();

    const enter = header.enter().append("g")
      .attr("class", "container-header")
      .attr("tabindex", 0)
      .attr("role", "button")
      .style("cursor", "pointer");
    enter.append("rect").attr("class", "container-header-hit");
    enter.append("circle").attr("class", "container-dot");
    enter.append("text").attr("class", "container-title");
    const badge = enter.append("g").attr("class", "container-badge");
    badge.append("rect").attr("class", "container-badge-bg").attr("rx", 8);
    badge.append("text").attr("class", "container-count")
      .attr("text-anchor", "middle").attr("dominant-baseline", "central");

    const all = enter.merge(header);
    all
      .attr("aria-label", (node) => `${displayOf(node)}（${node.kind}）容器，${memberCountOf(node.id)} 个成员`)
      .each((node) => {
        applyContainerGeometry(node);
      });
    all.select("circle.container-dot").attr("fill", (node) => containerColorOf(node.id));
    all.select<SVGRectElement>(".container-badge-bg").attr("x", -13).attr("y", -9).attr("width", 26).attr("height", 18);
    all.select<SVGTextElement>(".container-title")
      .attr("dominant-baseline", "central")
      .style("font-family", "var(--font-sans)")
      .attr("font-size", "12px")
      .attr("font-weight", "600")
      .style("pointer-events", "none")
      .style("user-select", "none");

    all
      .on("keydown", (event: KeyboardEvent, node: SimNode) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onContainerClick(node);
        }
      })
      .on("focus", (_event: FocusEvent, node: SimNode) => syncContainerFocus(node.id, true))
      .on("blur", (_event: FocusEvent, node: SimNode) => syncContainerFocus(node.id, false))
      .on("click", (event: MouseEvent, node: SimNode) => {
        event.stopPropagation();
        onContainerClick(node);
      })
      .call(nodeDragBehavior());
  }

  /** 焦点态跨层同步：键盘聚焦头部条时，底板框体同步 is-focused 提亮描边 */
  function syncContainerFocus(id: string, focused: boolean): void {
    if (!zoomGroup) return;
    for (const selector of [".containers > g.container-group", ".container-headers > g.container-header"]) {
      zoomGroup
        .selectAll<SVGGElement, SimNode>(selector)
        .filter((item) => item.id === id)
        .classed("is-focused", focused);
    }
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

    // 附属标注角标（D46 annotation 恰一宿主）：宿主星体右上角小徽章，显示附属计数
    all.each(function (this: SVGGElement, node: SimNode) {
      const group = d3.select(this);
      const attached = layered.hostBadges.get(node.id) ?? [];
      const existing = group.select<SVGGElement>("g.affiliated-badge");
      if (attached.length === 0) {
        existing.remove();
        return;
      }
      const badge = existing.empty()
        ? group.append("g").attr("class", "affiliated-badge").attr("role", "button").attr("tabindex", 0)
        : existing;
      badge
        .attr("transform", `translate(${NODE_R + 7},${-(NODE_R + 7)})`)
        .attr("aria-label", `${attached.length} 个附属对象`);
      if (badge.select("circle.affiliated-badge-bg").empty()) {
        badge.append("circle").attr("class", "affiliated-badge-bg").attr("r", 9);
        badge.append("text").attr("class", "affiliated-badge-count")
          .attr("text-anchor", "middle").attr("dominant-baseline", "central");
      }
      badge.select("text.affiliated-badge-count").text(String(attached.length));
      badge
        .on("click", (event: MouseEvent) => {
          event.stopPropagation();
          event.preventDefault();
          openBadgePopup(node);
        })
        .on("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openBadgePopup(node);
          }
        });
    });

    all
      .attr("aria-label", (node) => `${displayOf(node)}（${node.kind}）`)
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
        if (displayOf(node).length > 20 && tooltipEl && wrapperEl) {
          const rect = wrapperEl.getBoundingClientRect();
          tooltipEl.textContent = displayOf(node);
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

    // 拖拽（位置写入缓存；视图状态，不触发 Core 写入）——行为与容器条共用
    all.call(nodeDragBehavior());
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
    userMovedView = true; // 工具轨/键盘缩放同属用户手动视角移动，布局收敛后不再抢取景
    d3.select(svgEl).transition().duration(300).call(zoomBehavior.scaleBy, 1.3);
  }

  function zoomOut(): void {
    if (!svgEl || !zoomBehavior) return;
    userMovedView = true;
    d3.select(svgEl).transition().duration(300).call(zoomBehavior.scaleBy, 0.7);
  }

  // ── 全量渲染（节点内容变化 / 首次加载）──
  function renderGraph(): void {
    if (!svgEl || !wrapperEl) return;
    const snapshot = store.snapshot;
    if (!snapshot) return;
    const { w, h } = getContainerSize();
    const graphId = snapshot.graphId;
    const isGraphSwitch = currentGraphId !== "" && currentGraphId !== graphId;
    currentGraphId = graphId;
    const positions = positionsFor(graphId);
    currentPositions = positions;

    const svg = d3.select(svgEl);
    const previousTransform = (svgEl as SVGSVGElement & { __zoom?: d3.ZoomTransform }).__zoom;
    if (isGraphSwitch) {
      expandedContainers = {};
      badgePopup = null;
    }
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
          if (isUserViewportInput(event.sourceEvent as Event | undefined)) {
            userMovedView = true;
            badgePopup = null; // 视口手势后宿主屏幕锚点失效，附属浮层收起
          }
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

    // 语义分层（D46）：容器分区 / 附属标注 / 普通星体
    layered = computeLayeredSemantics(snapshot.objects, snapshot.relations);

    // 节点（位置缓存种子；确定性网格兜底）。布局层 = 除标注外全部对象：
    // 容器参与布局（星体成员经 member_of 链力聚拢）；标注不画星体、不入模拟。
    const layoutObjects = snapshot.objects.filter((object) => representOfKind(object.kind) !== "annotation");
    const seed = seedGridLayout(layoutObjects.length);
    const bySeed = new Map(layoutObjects.map((object, index) => [object.id, seed[index]]));
    const nodes: SimNode[] = layoutObjects.map((object) => {
      const cached = positions.get(object.id);
      const base = cached ?? bySeed.get(object.id) ?? { x: 0, y: 0 };
      return { ...object, x: base.x, y: base.y };
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    // 布局边 = 两端都在布局层的关系（member_of→容器 保留以聚拢成员；标注边两端不全在 → 自然剔除）；
    // 可见边 = 布局边去掉 member_of→声明容器（容器分区已表达成员归属，不画线）
    const { layoutEdges, visibleEdges } = partitionLayoutEdges(snapshot.relations, nodeIds, layered.containerIds);

    currentNodes = nodes;
    currentEdges = visibleEdges;

    simulation?.stop();
    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink<SimNode, SimEdge>(layoutEdges).id((node) => node.id).distance(160))
      .force("charge", d3.forceManyBody().strength(-Math.min(800, 300 + nodes.length * 25)))
      .force("center", d3.forceCenter(w / 2, h / 2))
      .force("collision", d3.forceCollide<SimNode>().radius(NODE_R + 8))
      .alphaDecay(0.02);

    renderContainerLayer(zoomGroup, nodes.filter((node) => layered.containerIds.has(node.id)));
    renderEdgeLayer(zoomGroup, visibleEdges);
    renderNodeLayer(zoomGroup, nodes.filter((node) => !layered.containerIds.has(node.id)));
    // 头部条层最后渲染：压过成员星体与其附属角标（缺陷①：展开态标题点被角标吞点击）
    renderContainerHeaderLayer(zoomGroup, nodes.filter((node) => layered.containerIds.has(node.id)));
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
    const containerSel = zoomGroup.selectAll<SVGGElement, SimNode>(".containers > g.container-group");
    const headerSel = zoomGroup.selectAll<SVGGElement, SimNode>(".container-headers > g.container-header");
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
      containerSel.attr("transform", (node) => `translate(${node.x ?? 0},${node.y ?? 0})`);
      headerSel
        .attr("transform", (node) => `translate(${node.x ?? 0},${node.y ?? 0})`)
        .each((node) => {
          // 展开分区逐帧包围成员当前位置；折叠条几何固定（仅位移）
          if (expandedContainers[node.id]) applyContainerGeometry(node);
        });

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
      // 仅「无交互的初始布局收敛」才补一次取景；用户拖拽过布局或动过视角都不再抢（缺陷③）
      if (!userMovedView && !touchedLayout) autoFit();
    });

    if (fitFallbackTimer) clearTimeout(fitFallbackTimer);
    fitDone = false;
    touchedLayout = false;
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
    layered = computeLayeredSemantics(snapshot.objects, snapshot.relations);
    // 与全量渲染同口径：布局层排除标注对象
    const layoutObjects = snapshot.objects.filter((object) => representOfKind(object.kind) !== "annotation");
    const newNodeIds = new Set(layoutObjects.map((object) => object.id));
    const sameNodes = currentNodes.length === layoutObjects.length
      && currentNodes.every((node) => newNodeIds.has(node.id))
      && nodeContentKey(currentNodes) === nodeContentKey(layoutObjects);
    if (!sameNodes) {
      renderGraph();
      return;
    }
    const nodeIds = new Set(currentNodes.map((node) => node.id));
    const { layoutEdges, visibleEdges } = partitionLayoutEdges(snapshot.relations, nodeIds, layered.containerIds);
    currentEdges = visibleEdges;
    renderEdgeLayer(zoomGroup, visibleEdges);
    simulation.force("link", d3.forceLink<SimNode, SimEdge>(layoutEdges).id((node) => node.id).distance(160));
    simulation.alpha(0.3).restart();
    applyFiltersAndSelection();
  }

  // ── 数据流：内容变化决定全量重建 or 增量同步 ──
  let lastNodeKey: string | null = null;
  let lastEdgeKey: string | null = null;
  let lastBadgeKey: string | null = null;
  $effect(() => {
    const snapshot = store.snapshot;
    const catalog = store.catalog; // represent 声明随目录 reset 变化 → 分层结构重建
    if (!snapshot || !svgEl) return;
    const representKey = stableKey(snapshot.objects.map((object) => ({ id: object.id, r: representOfKind(object.kind) })));
    const nodeKey = `${nodeContentKey(snapshot.objects)}|${representKey}`;
    const edgeKey = edgeContentKey(snapshot.relations);
    const badgeKey = stableKey({
      badges: [...computeLayeredSemantics(snapshot.objects, snapshot.relations).hostBadges]
        .map(([hostId, annotations]) => ({ hostId, annotations: annotations.map((a) => a.id) })),
      fallback: snapshot.objects
        .filter((object) => representOfKind(object.kind) === "annotation")
        .map((object) => object.id),
    });
    const identityChanged = snapshot.graphId !== currentGraphId;
    const nodeChanged = lastNodeKey !== null && nodeKey !== lastNodeKey;
    const edgeChanged = lastEdgeKey !== null && edgeKey !== lastEdgeKey;
    const badgeChanged = lastBadgeKey !== null && badgeKey !== lastBadgeKey;
    const isFirst = lastNodeKey === null;
    lastNodeKey = nodeKey;
    lastEdgeKey = edgeKey;
    lastBadgeKey = badgeKey;
    if (isFirst || identityChanged || nodeChanged || badgeChanged) renderGraph();
    else if (edgeChanged) syncEdges();
  });

  // 模块 presentation 变化 → 重刷星体与渐变
  $effect(() => {
    void store.catalog;
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

  // 选择/过滤/容器类选中变化 → 增量着色
  $effect(() => {
    void store.selection;
    void store.selectedContainerId;
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

  // 定位请求（搜索 Enter、看板行点击）：平移居中到目标（+局部锚点偏移；容器展开态=框中心）
  $effect(() => {
    const request = store.locateRequest;
    if (!request || !svgEl || !zoomBehavior) return;
    const node = currentNodes.find((candidate) => candidate.id === request.nodeId);
    if (!node || node.x === undefined || node.y === undefined) return;
    userMovedView = true; // 定位是用户主动的视角移动，布局收敛后不再抢取景
    const { w, h } = getContainerSize();
    const k = (svgEl as SVGSVGElement & { __zoom?: d3.ZoomTransform }).__zoom?.k ?? 1;
    const offsetX = request.offsetX ?? 0;
    const offsetY = request.offsetY ?? 0;
    d3.select(svgEl)
      .transition().duration(prefersReducedMotion ? 0 : 300).ease(d3.easeCubicOut)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-(node.x + offsetX), -(node.y + offsetY)));
  });

  // Tab 分组循环：焦点只在可见星体与容器头部条之间循环
  function canvasKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const active = document.activeElement as HTMLElement | null;
    if (!active?.classList.contains("node") && !active?.classList.contains("container-header")) return;
    event.preventDefault();
    const group = Array.from(
      wrapperEl?.querySelectorAll<HTMLElement>("g.node:not(.dimmed), g.container-header") ?? [],
    );
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

    // 画布空白处点击 = 清除选中（焦点残留一并交还）；附属浮层一并收起
    d3.select(svgEl).on("click.bg", (event: MouseEvent) => {
      const target = event.target as Element;
      if (target === svgEl || target.classList?.contains("grid-bg")) {
        badgePopup = null;
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
      } else if (event.key === "Escape") {
        // 逐层消费（缺陷②）：画布层只吃自己的一层——附属浮层 → 聚焦容器；吃到就拦截
        // 外壳 Esc 梯（编辑器→选中→浮层→过滤），保证一次 Esc 只消费一层。
        // 监听挂在 capture 相位：无论外壳 svelte:window 的注册先后，画布层都先执行。
        let consumed = false;
        if (badgePopup) {
          badgePopup = null;
          consumed = true;
        } else {
          const target = event.target;
          if (
            target instanceof Element
            && (target.classList.contains("container-header") || target.classList.contains("container-group"))
          ) {
            const node = d3.select(target).datum() as SimNode | undefined;
            if (node && (expandedContainers[node.id] ?? false)) collapseContainer(node);
            (target as SVGGElement).blur?.();
            consumed = true; // 聚焦容器本身就是一层（未展开也退出聚焦）
          }
        }
        if (consumed) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }
    };
    window.addEventListener("keydown", handleKeydown, true);
    const handlePointerEnd = (event: PointerEvent) => endMiddlePan(event.pointerId);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("keydown", handleKeydown, true);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  });

  onDestroy(() => {
    endMiddlePan();
    simulation?.stop();
    if (svgEl) d3.select(svgEl).interrupt(); // 取消在途视图过渡（fit/缩放/定位），卸载后不再被定时器队列回调
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

  <!-- 附属标注浮层（角标点击弹出）：列表项点击 = store.select → ObjectDetail 抽屉 -->
  {#if badgePopup && badgePopupItems.length > 0}
    <div class="affiliated-pop" style="left: {badgePopup.x}px; top: {badgePopup.y}px" role="menu" aria-label="附属对象浮层">
      <span class="affiliated-pop-title">附属 · {badgePopupItems.length}</span>
      {#each badgePopupItems as annotation (annotation.id)}
        <button class="affiliated-item" onclick={() => selectAffiliated(annotation.id)} title={annotation.kind}>
          <code class="affiliated-id">{annotation.id}</code>
          {#if titleOf(annotation)}<span class="affiliated-label">{titleOf(annotation)}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  <!-- 右缘堆叠：容器看板（R2，右上角）+ 附属侧栏兜底；同栈互不重叠 -->
  {#if containerRows.length > 0 || affiliatedGroups.length > 0}
    <div class="right-stack" class:drawer-shifted={drawerOpen}>
      {#if containerRows.length > 0}
        <section class="container-board" data-open={boardOpen} aria-label="容器看板">
          <div class="container-board-head">
            <span class="container-board-title">容器 · {containerRows.length}</span>
            <button
              class="board-collapse-btn"
              type="button"
              onclick={() => (boardOpen = !boardOpen)}
              aria-expanded={boardOpen}
            >
              {boardOpen ? "收起看板" : "展开看板"}
            </button>
          </div>
          <div class="container-board-rows" role="list">
            {#each containerRows as row (row.id)}
              <div class="container-row" class:active={row.selected} role="listitem">
                <button
                  class="container-row-main"
                  type="button"
                  onclick={() => locateContainerFromBoard(row.id)}
                  title="{row.title}（{row.kind}）"
                  aria-pressed={row.selected}
                  aria-label="定位并选中容器 {row.title}，{row.count} 个成员"
                >
                  <span class="row-dot" style="background: {row.color}"></span>
                  <span class="row-title">{row.title}</span>
                  <span class="row-count">{row.count}</span>
                  <span class="row-state">{row.expanded ? "展开" : "折叠"}</span>
                </button>
                <button class="row-toggle" type="button" onclick={() => toggleContainerFromBoard(row.id)}>
                  {row.expanded ? "收起" : "展开"}
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}
      {#if affiliatedGroups.length > 0}
        <aside class="affiliated-aside" aria-label="附属对象列表">
          {#each affiliatedGroups as [kind, items] (kind)}
            <section class="affiliated-kind-group">
              <h4 class="affiliated-kind-title">{kind} <span class="affiliated-kind-n">{items.length}</span></h4>
              <div class="affiliated-list">
                {#each items as annotation (annotation.id)}
                  <button class="affiliated-item" onclick={() => selectAffiliated(annotation.id)}>
                    <code class="affiliated-id">{annotation.id}</code>
                    {#if titleOf(annotation)}<span class="affiliated-label">{titleOf(annotation)}</span>{/if}
                  </button>
                {/each}
              </div>
            </section>
          {/each}
        </aside>
      {/if}
    </div>
  {/if}

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

    /* 选中类成员光晕（R4）：实例色 drop-shadow 克制脉动（颜色变量按节点下放） */
    .nodes g.node.is-class-glow .star-sky {
      animation: class-glow-pulse 2.6s ease-in-out infinite;
    }
    @keyframes class-glow-pulse {
      0%, 100% { filter: drop-shadow(0 0 2px var(--class-glow-color)) drop-shadow(0 0 5px var(--class-glow-color)); }
      50% { filter: drop-shadow(0 0 4px var(--class-glow-color)) drop-shadow(0 0 9px var(--class-glow-color)); }
    }

    @media (prefers-reduced-motion: reduce) {
      .nodes g.node .star-halo,
      .nodes g.node .star-spikes,
      .nodes g.node .star-core,
      .nodes g.node .prism-r,
      .nodes g.node .prism-b {
        animation: none;
      }
      /* 选中类光晕（R4）：reduced-motion 下静态无动画 */
      .nodes g.node.is-class-glow .star-sky {
        animation: none;
        filter: drop-shadow(0 0 3px var(--class-glow-color));
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
  .graph-canvas :global(g.node:focus),
  .graph-canvas :global(g.container-group:focus),
  .graph-canvas :global(g.container-header:focus) {
    outline: none;
  }

  /* ── 容器分区（D46 container）：玻璃底板 + 顶层头部条（d3 生成 DOM → :global）── */
  :global {
    .containers g.container-group .container-body {
      fill: var(--glass);
      stroke: var(--glass-line);
      stroke-width: 1;
      transition: stroke 0.13s var(--ease-out-quart), fill 0.13s var(--ease-out-quart);
    }
    .containers g.container-group:hover .container-body,
    .containers g.container-group.is-focused .container-body {
      stroke: var(--line-strong);
      fill: rgba(13, 15, 20, 0.82);
    }
    .containers g.container-group.expanded .container-body {
      fill: rgba(13, 15, 20, 0.55);
      /* 实例色（R1）：半透明哈希色描边，变量由 applyContainerGeometry 按容器 id 下放 */
      stroke: var(--container-stroke, var(--glass-line));
    }
    .containers g.container-group.is-selected .container-body {
      /* 选中类（R4）：实例色提亮 + 线宽加粗 */
      stroke: var(--container-stroke-selected, var(--line-strong));
      stroke-width: 2;
    }
    .containers g.container-group.is-dragging {
      cursor: grabbing;
    }

    /* 头部条（dot + 标题 + 计数徽章）：独立末层，展开态命中优先于成员星体/角标 */
    .container-headers g.container-header .container-header-hit {
      fill: transparent;
      pointer-events: all;
      display: none;
    }
    .container-headers g.container-header.expanded .container-header-hit {
      display: block;
    }
    .container-headers g.container-header .container-title {
      fill: var(--ink);
      letter-spacing: 0.02em;
      paint-order: stroke;
      stroke: #000000;
      stroke-width: 3px;
      stroke-linejoin: round;
      pointer-events: none;
      user-select: none;
    }
    .container-headers g.container-header .container-badge-bg {
      fill: var(--wash-2);
      stroke: var(--glass-line);
    }
    .container-headers g.container-header .container-badge.empty {
      opacity: 0.45;
    }
    .container-headers g.container-header .container-count {
      fill: var(--ink-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      pointer-events: none;
    }
    .container-headers g.container-header.is-dragging {
      cursor: grabbing;
    }

    /* ── 附属角标（D46 annotation 恰一宿主）：宿主星体右上角小徽章 ── */
    .nodes g.node g.affiliated-badge {
      cursor: pointer;
    }
    .nodes g.node g.affiliated-badge .affiliated-badge-bg {
      fill: var(--wash-3);
      stroke: rgba(255, 255, 255, 0.4);
      stroke-width: 1;
      transition: fill 0.13s var(--ease-out-quart);
    }
    .nodes g.node g.affiliated-badge:hover .affiliated-badge-bg,
    .nodes g.node g.affiliated-badge:focus .affiliated-badge-bg {
      fill: rgba(255, 255, 255, 0.22);
    }
    .nodes g.node g.affiliated-badge .affiliated-badge-count {
      fill: var(--ink);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      pointer-events: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .containers g.container-group .container-body,
      .nodes g.node g.affiliated-badge .affiliated-badge-bg {
        transition: none;
      }
    }
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

  /* ── 附属标注浮层（角标点击弹出；锚定宿主屏幕坐标的玻璃小卡）── */
  .affiliated-pop {
    position: absolute;
    min-width: 180px;
    max-width: 260px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-2);
    background: var(--glass-strong);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line, var(--line));
    border-radius: var(--r);
    box-shadow: var(--shadow-float), inset 0 1px 0 var(--hi-line);
    z-index: var(--z-panel);
  }

  .affiliated-pop-title {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 650;
    color: var(--ink-faint);
    padding: 0 var(--sp-1) var(--sp-1);
  }

  /* ── 右缘堆叠：容器看板（R2，右上角）+ 附属侧栏兜底；同栈互不重叠 ── */
  .right-stack {
    position: absolute;
    right: 12px;
    top: 12px;
    bottom: 64px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--sp-3);
    pointer-events: none;
    z-index: var(--z-overlay);
    /* 让位回位与抽屉滑入同节奏（DetailDrawer 0.22s ease-out-quint） */
    transition: transform 0.22s var(--ease-out-quint);
  }

  /* 抽屉打开：整栈左移让位（抽屉最宽 400px + 右缘 12px + 呼吸 12px），关阔回位 */
  .right-stack.drawer-shifted {
    transform: translateX(-424px);
  }

  @media (max-width: 768px) {
    /* 窄屏抽屉全宽弹出，让位无意义 */
    .right-stack.drawer-shifted {
      transform: none;
    }
  }

  .right-stack > * {
    pointer-events: auto;
  }

  /* 容器看板（R2）：每行 = 实例色点 + 标题 + 计数 + 折叠态 + 展开/收起按钮 */
  .container-board {
    width: 272px;
    max-width: calc(100vw - 96px);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-2);
    background: var(--glass-strong);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line, var(--line));
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-float), inset 0 1px 0 var(--hi-line);
  }

  .container-board-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: 0 var(--sp-1) var(--sp-1);
  }

  .container-board-title {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 650;
    color: var(--ink-faint);
    letter-spacing: 0.02em;
  }

  /* 看板收纳入口：默认可见（活代码），仅宽屏隐藏——收纳是窄屏（≤768px）专属语义 */
  .board-collapse-btn {
    display: inline-block;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    padding: 1px var(--sp-2);
    cursor: pointer;
  }

  .container-board-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .container-row {
    display: flex;
    align-items: stretch;
    gap: 4px;
  }

  .container-row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 3px var(--sp-2);
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    transition: background 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .container-row-main:hover {
    background: var(--wash-2);
    border-color: var(--line-strong);
  }

  .container-row.active .container-row-main {
    background: var(--wash-3);
    border-color: var(--line-strong);
  }

  .row-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .row-title {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-count {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .row-state {
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    flex-shrink: 0;
  }

  .row-toggle {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-sm);
    color: var(--ink-muted);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
    font-weight: 600;
    padding: 1px var(--sp-2);
    cursor: pointer;
    transition: color 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .row-toggle:hover {
    color: var(--ink);
    border-color: var(--ink-faint);
  }

  .container-row-main:focus-visible,
  .row-toggle:focus-visible,
  .board-collapse-btn:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  /* 宽屏（≥769px）：行区常开、收纳入口隐藏 */
  @media (min-width: 769px) {
    .board-collapse-btn { display: none; }
  }

  /* 窄屏（≤768px）：看板收纳为可展开，行区默认隐藏，由收纳入口展开 */
  @media (max-width: 768px) {
    .container-board-rows { display: none; }
    .container-board[data-open="true"] .container-board-rows { display: flex; }
  }

  @media (prefers-reduced-motion: reduce) {
    .container-row-main,
    .row-toggle {
      transition: none;
    }
    .right-stack {
      transition: none; /* 让位回位随之静态化 */
    }
  }

  /* ── 附属侧栏（零/多宿主标注兜底；风格对齐 App.svelte 静态预览列表；置于右缘堆叠栈内）── */
  .affiliated-aside {
    width: 232px;
    max-height: 100%;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--glass);
    -webkit-backdrop-filter: var(--blur-panel);
    backdrop-filter: var(--blur-panel);
    border: 1px solid var(--glass-line, var(--line));
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-float), inset 0 1px 0 var(--hi-line);
  }

  .affiliated-kind-group {
    display: flex;
    flex-direction: column;
  }

  .affiliated-kind-title {
    margin: 0 0 var(--sp-1);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 650;
    color: var(--ink-muted);
  }

  .affiliated-kind-n {
    opacity: 0.5;
    font-weight: 400;
  }

  .affiliated-list {
    display: grid;
    gap: 4px;
  }

  .affiliated-item {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2);
    min-width: 0;
    padding: var(--sp-1) var(--sp-2);
    background: var(--wash-1);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    font-size: var(--text-xs);
    transition: background 0.13s var(--ease-out-quart), border-color 0.13s var(--ease-out-quart);
  }

  .affiliated-item:hover {
    background: var(--wash-2);
    border-color: var(--line-strong);
  }

  .affiliated-item:focus-visible {
    outline: 2px solid var(--interactive);
    outline-offset: 1px;
  }

  .affiliated-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-faint);
    flex-shrink: 0;
    max-width: 92px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .affiliated-label {
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .affiliated-item { transition: none; }
  }
</style>
