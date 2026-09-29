import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphCanvas from "./GraphCanvas.svelte";
import { store } from "./store.svelte";
import { seedGridLayout } from "./layout";
import { fallbackKindColor } from "./moduleProjection";
import type { Catalog, GraphSnapshot } from "./protocol";
import { obj, rel } from "./test-support";

// jsdom 未实现 SVGSVGElement.viewBox（d3-zoom 的 extent 计算依赖它）→ 测试环境补齐，
// 让看板定位触发的 d3 视图过渡可以安全跑完（否则定时器 flush 时抛未捕获异常污染套件）。
Object.defineProperty(SVGSVGElement.prototype, "viewBox", {
  configurable: true,
  get(this: SVGSVGElement) {
    const [x = 0, y = 0, width = 0, height = 0] = (this.getAttribute("viewBox") ?? "")
      .split(/[\s,]+/)
      .filter((part) => part !== "")
      .map(Number);
    return { baseVal: { x, y, width, height } };
  },
});

const snapshot: GraphSnapshot = {
  graphId: "demo",
  revision: 7,
  objects: [
    obj("a-1", "research.question", "问题 A（超过二十个字符的很长标签用于触发截断逻辑哦）"),
    obj("b-1", "plain", "对象 B"),
    obj("c-1", "plain", "对象 C"),
  ],
  relations: [
    rel("r-1", "supports", "b-1", "a-1"),
    rel("r-2", "related", "b-1", "c-1", "undirected"),
    rel("r-broken", "related", "b-1", "missing"),
  ],
};

// D46 语义分层 mock catalog：represent 声明与实现（daemon catalog）并行开发
const layeredCatalog: Catalog = {
  modules: [{ id: "wf", namespace: "wf", version: "1.0.0" }],
  kinds: [
    { kind: "wf.group", owner: "wf", represent: "container" },
    { kind: "wf.report", owner: "wf", represent: "annotation" },
    { kind: "wf.task", owner: "wf" },
  ],
  commands: [],
};

const layeredSnapshot: GraphSnapshot = {
  graphId: "layered",
  revision: 3,
  objects: [
    obj("grp-1", "wf.group", "容器一"),
    obj("t-1", "wf.task", "任务一"),
    obj("t-2", "wf.task", "任务二"),
    obj("rep-1", "wf.report", "报告一"), // 恰一宿主 t-1（wf.report_of）→ 角标
    obj("rep-2", "wf.report", "报告二"), // 零宿主 → 侧栏兜底
    obj("rep-3", "wf.report", "报告三"), // 两条宿主边 → 侧栏兜底
    obj("rep-4", "wf.report", "报告四"), // member_of → 容器成员（不角标、不侧栏）
    obj("plain-1", "plain", "普通星体"),
    obj("plain-2", "plain", "普通星体二"),
  ],
  relations: [
    rel("m-1", "member_of", "t-1", "grp-1"),
    rel("m-2", "member_of", "t-2", "grp-1"),
    rel("m-3", "member_of", "rep-4", "grp-1"),
    rel("r-of-1", "wf.report_of", "rep-1", "t-1"),
    rel("r-of-2", "wf.report_of", "rep-3", "t-1"),
    rel("r-of-3", "wf.report_of", "rep-3", "t-2"),
    rel("dep-1", "wf.depends_on", "t-1", "plain-2"),
  ],
};

function loadSnapshot(next: GraphSnapshot): void {
  store.snapshot = next;
  store.loading = false;
}

async function mountCanvas(): Promise<{ target: HTMLDivElement; done: () => void }> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const component = mount(GraphCanvas, { target });
  await tick();
  await tick();
  return {
    target,
    done: () => {
      unmount(component);
      target.remove();
    },
  };
}

function labelsOf(target: ParentNode, selector: string): string[] {
  return [...target.querySelectorAll<SVGGElement>(selector)].map((element) => element.getAttribute("aria-label") ?? "");
}

describe("GraphCanvas", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.selectedContainerId = null;
    store.searchQuery = "";
    store.kindFilter = "";
    store.catalog = null;
  });

  it("渲染的对象/关系数量与快照一致，端点缺失的关系被剔除", async () => {
    loadSnapshot(snapshot);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(GraphCanvas, { target });
    await tick();
    await tick();
    expect(target.querySelectorAll("g.node").length).toBe(3);
    // r-broken 的 target 缺失：不进渲染层
    expect(target.querySelectorAll("g.edge-group").length).toBe(2);
    // directed 关系有方向折角，undirected 没有
    const dirs = [...target.querySelectorAll<SVGPathElement>(".edge-dir")];
    expect(dirs.filter((path) => path.getAttribute("opacity") === "1").length).toBe(1);
    unmount(component);
    target.remove();
  });

  it("点击节点/关系把稳定 ID 写入选择状态，空白点击清除", async () => {
    loadSnapshot(snapshot);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(GraphCanvas, { target });
    await tick();
    await tick();

    const node = target.querySelector("g.node") as SVGGElement;
    const hitArea = node.querySelector(".node-hit-area") as SVGRectElement;
    expect(hitArea).not.toBeNull();
    hitArea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "a-1" });

    const edgeGroup = target.querySelector("g.edge-group") as SVGGElement;
    edgeGroup.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toEqual({ type: "relation", id: "r-1" });

    const svg = target.querySelector("svg.graph-canvas") as SVGSVGElement;
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toBeNull();
    unmount(component);
    target.remove();
  });

  it("kind 过滤淡出不匹配的星体；渲染不因重复加载抖动坐标缓存", async () => {
    loadSnapshot(snapshot);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(GraphCanvas, { target });
    await tick();
    await tick();
    store.kindFilter = "plain";
    await tick();
    const dimmed = target.querySelectorAll("g.node.dimmed");
    expect(dimmed.length).toBe(1);
    expect(dimmed[0].getAttribute("aria-label")).toContain("research.question");
    unmount(component);
    target.remove();
  });
});

describe("GraphCanvas 语义分层渲染（D46 represent）", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.selectedContainerId = null;
    store.searchQuery = "";
    store.kindFilter = "";
    store.catalog = null;
  });

  it("container 声明 → 玻璃容器分区（标题/折叠计数徽章），不再画星体；member_of 不画线", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    // 容器：底板层（g.container-group）+ 头部条层（g.container-header），不进星体层
    const containers = target.querySelectorAll("g.container-group");
    const headers = target.querySelectorAll("g.container-header");
    expect(containers.length).toBe(1);
    expect(headers.length).toBe(1);
    expect(labelsOf(target, "g.container-header")[0]).toContain("容器一");
    expect(labelsOf(target, "g.node").join("\n")).not.toContain("容器一");
    // 普通星体 = 4（t-1/t-2/plain-1/plain-2）；标注与容器不画星体
    expect(target.querySelectorAll("g.node").length).toBe(4);

    // 标题 = displayOf(object)；默认折叠 + 成员计数徽章（t-1/t-2/rep-4 共 3 个成员）
    expect(headers[0].querySelector(".container-title")?.textContent).toBe("容器一");
    expect(containers[0].classList.contains("collapsed")).toBe(true);
    expect(headers[0].classList.contains("collapsed")).toBe(true);
    expect(headers[0].getAttribute("aria-expanded")).toBe("false");
    expect(headers[0].querySelector(".container-count")?.textContent).toBe("3");

    // member_of 不画线（容器已表达）；标注参与的 report_of 也不画（标注不是星体）；
    // 普通星体关系照常画线（dep-1 一条）
    expect(target.querySelectorAll("g.edge-group").length).toBe(1);
    done();
  });

  it("折叠条点击仅选中（R5）；展开/收起走看板按钮，底板与头部条 aria/类同步", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    const header = target.querySelector("g.container-header") as SVGGElement;
    // 折叠条点击 = 仅选中该类，不再展开
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(store.selectedContainerId).toBe("grp-1");

    // 展开入口只在看板：按钮展开 → 头部条/框体点击收起
    const toggle = target.querySelector(".row-toggle") as HTMLButtonElement;
    expect(toggle.textContent?.trim()).toBe("展开");
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent?.trim()).toBe("收起");

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent?.trim()).toBe("展开");
    done();
  });

  it("展开分区几何以容器局部坐标包围成员星体（底板不叠加容器自身位移），收起再展开可靠", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    // 展开入口只在看板（R5）：经看板按钮展开后断言几何
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    // 断言前只有微任务（模拟尚未起跑）→ 成员坐标 = seedGridLayout 种子。
    // 布局层顺序 = objects 剔除 annotation：grp-1, t-1, t-2, plain-1, plain-2。
    // 底板几何 = 成员坐标换算到容器局部系后的包围盒（容器自身为种子）+ 内边距。
    const seed = seedGridLayout(5);
    const [grp, t1, t2] = seed;
    const locals = [t1!, t2!].map((point) => ({ x: point.x - grp!.x, y: point.y - grp!.y })); // 容器成员 t-1/t-2
    const minX = Math.min(0, ...locals.map((point) => point.x));
    const minY = Math.min(0, ...locals.map((point) => point.y));
    const maxX = Math.max(0, ...locals.map((point) => point.x));
    const maxY = Math.max(0, ...locals.map((point) => point.y));
    const body = () => container.querySelector(".container-body") as SVGRectElement;

    expect(Number(body().getAttribute("x"))).toBe(minX - 20);
    expect(Number(body().getAttribute("y"))).toBe(minY - 46);
    expect(Number(body().getAttribute("width"))).toBe(Math.max(132, maxX - minX + 40));
    expect(Number(body().getAttribute("height"))).toBe(Math.max(36, maxY - minY + 66));

    // 头部条（顶层）：标题行随框顶行展开，命中区覆盖框顶行（角标与标题同点时点击优先头部条）
    const header = () => target.querySelector("g.container-header") as SVGGElement;
    expect(Number(header().querySelector(".container-title")!.getAttribute("x"))).toBe(minX - 20 + 26);
    expect(Number(header().querySelector(".container-title")!.getAttribute("y"))).toBe(minY - 46 + 19);
    const hit = () => header().querySelector(".container-header-hit") as SVGRectElement;
    expect(Number(hit().getAttribute("x"))).toBe(minX - 20);
    expect(Number(hit().getAttribute("y"))).toBe(minY - 46);
    expect(Number(hit().getAttribute("height"))).toBe(38);

    // 收起恢复折叠条；再次展开几何一致（不残留上次的展开偏移）
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(Number(body().getAttribute("width"))).toBe(132); // 折叠条宽度 = barWidth
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);
    expect(Number(body().getAttribute("x"))).toBe(minX - 20);
    expect(Number(body().getAttribute("y"))).toBe(minY - 46);
    done();
  });

  it("缺陷①回归：展开态头部条渲染于成员角标之上（zoomGroup 末层），点标题条/命中区/Enter 可靠收起", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    // SVG 无 z-index：文档顺序 = 视觉/命中最上层。头部条层必须在 .nodes 之后，
    // 否则成员星体的附属角标（g.affiliated-badge，画在 .nodes 层）会盖住容器标题并吞掉点击。
    const zoomGroup = target.querySelector("g.zoom-group") as SVGGElement;
    const layerNames = [...zoomGroup.children].map((element) => element.getAttribute("class") ?? "");
    expect(layerNames.indexOf("container-headers")).toBeGreaterThan(layerNames.indexOf("nodes"));
    expect(layerNames[layerNames.length - 1]).toBe("container-headers");

    const header = target.querySelector("g.container-header") as SVGGElement;
    const container = target.querySelector("g.container-group") as SVGGElement;
    // 展开入口只在看板（R5）：看板按钮展开后验证头部条命中区
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);

    // 展开态命中区覆盖框顶行：成员角标与标题同点时命中头部条 → 可靠收起
    const hit = header.querySelector(".container-header-hit") as SVGRectElement;
    expect(Number(hit.getAttribute("width"))).toBeGreaterThan(0);
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    done();
  });

  it("缺陷②回归：Esc 逐层消费——收起聚焦容器时拦截外壳梯（选中保持），再按一次才落到外壳", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    // 模拟外壳 Esc 梯（App 的 svelte:window 为 bubble 监听，注册在画布 capture 监听之后）
    const shellLadder = vi.fn();
    window.addEventListener("keydown", shellLadder);

    store.select({ type: "object", id: "t-1" }); // 详情抽屉打开态
    const header = target.querySelector("g.container-header") as SVGGElement;
    const container = target.querySelector("g.container-group") as SVGGElement;
    // 展开入口只在看板（R5）：看板按钮展开后测 Esc 逐层
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);

    // 第一次 Esc（聚焦容器上）：画布层只收容器并拦截外壳梯 → 抽屉/选中保持
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(store.selection).toEqual({ type: "object", id: "t-1" });
    expect(shellLadder).not.toHaveBeenCalled();

    // 第二次 Esc（画布层无层可吃）：事件放行，外壳梯恢复运行
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(shellLadder).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", shellLadder);
    done();
  });

  it("折叠条点击选中该类并清节点选中（类选中独占，R4）；空白点击全清", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    store.select({ type: "object", id: "t-1" });
    await tick();
    const container = target.querySelector("g.container-group") as SVGGElement;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selectedContainerId).toBe("grp-1");
    expect(store.selection).toBeNull(); // 类选中独占：清节点选中
    // 选中类成员光晕（R4b）：实例色 drop-shadow（样式变量下放）
    const glowing = [...target.querySelectorAll<SVGGElement>("g.node.is-class-glow")];
    expect(glowing.length).toBe(2); // t-1/t-2（rep-4 标注成员不入模拟、不发光）
    expect(glowing.every((node) => (node.getAttribute("style") ?? "").includes(fallbackKindColor("grp-1")))).toBe(true);
    // 展开框描边走实例色 CSS 变量（R1a）
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect((container.getAttribute("style") ?? "")).toContain("--container-stroke");
    expect((container.getAttribute("style") ?? "")).toContain(fallbackKindColor("grp-1"));

    // 空白点击全清（类选中一并清除）
    const svg = target.querySelector("svg.graph-canvas") as SVGSVGElement;
    svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selectedContainerId).toBeNull();
    expect(target.querySelectorAll("g.node.is-class-glow").length).toBe(0);
    done();
  });

  it("Esc 命中聚焦容器时收起展开分区；Esc 不聚焦容器时不动展开状态", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    // 展开入口只在看板（R5）：看板按钮展开后测 Esc 逐层
    (target.querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);

    // Esc 在别处按下（target 非容器条）→ 不收起
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);

    // Esc 命中容器条（聚焦态按键的 target 即容器）→ 收起
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    const header = target.querySelector("g.container-header") as SVGGElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    done();
  });

  it("annotation 恰一宿主 → 宿主角标计数，点击浮层列出附属对象，列表项进详情", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    // rep-1 不画星体；宿主 t-1 挂角标（仅 rep-1；rep-3 两宿主走侧栏）
    expect(labelsOf(target, "g.node").join("\n")).not.toContain("报告一");
    const badges = target.querySelectorAll("g.affiliated-badge");
    expect(badges.length).toBe(1);
    expect(badges[0].querySelector(".affiliated-badge-count")?.textContent).toBe("1");

    // 点击角标弹出浮层，列表项 = 附属对象
    badges[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    const pop = target.querySelector(".affiliated-pop");
    expect(pop).not.toBeNull();
    expect(pop?.textContent).toContain("rep-1");
    expect(pop?.textContent).toContain("报告一");

    // 点列表项 = store.select 该对象（复用 ObjectDetail 抽屉），浮层收起
    (pop?.querySelector(".affiliated-item") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "rep-1" });
    expect(target.querySelector(".affiliated-pop")).toBeNull();
    done();
  });

  it("annotation 零/多宿主 → 右缘附属侧栏兜底（按 kind 分组），容器成员与角标对象不进侧栏", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const aside = target.querySelector("aside.affiliated-aside");
    expect(aside).not.toBeNull();
    const text = aside?.textContent ?? "";
    expect(text).toContain("报告二"); // 零宿主
    expect(text).toContain("rep-3"); // 多宿主
    expect(text).not.toContain("报告一"); // 角标对象不进侧栏
    expect(text).not.toContain("报告四"); // 容器成员不进侧栏
    expect(aside?.querySelectorAll(".affiliated-kind-group").length).toBe(1); // 同 kind 一组

    // 点击兜底列表项同样进详情
    (aside?.querySelector(".affiliated-item") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();
    expect(store.selection?.type).toBe("object");
    done();
  });

  it("搜索/过滤联动：kind 过滤时容器计数同步；附属兜底对象可被搜索命中进详情", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    store.kindFilter = "wf.task";
    await tick();
    // 成员被过滤时容器计数同步：3 个成员只剩 t-1/t-2（rep-4 是 wf.report）
    const header = target.querySelector("g.container-header") as SVGGElement;
    expect(header.querySelector(".container-count")?.textContent).toBe("2");

    store.kindFilter = "";
    store.searchQuery = "报告二";
    await tick();
    const aside = target.querySelector("aside.affiliated-aside");
    expect(aside).not.toBeNull();
    expect(aside?.textContent).toContain("报告二");
    expect(aside?.textContent).not.toContain("报告三");

    (aside?.querySelector(".affiliated-item") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "rep-2" });
    done();
  });

  it("目录未加载（catalog null）→ 全部按普通星体渲染（不妄断分层）", async () => {
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    expect(target.querySelectorAll("g.container-group").length).toBe(0);
    expect(target.querySelectorAll("g.node").length).toBe(9); // 全部对象都是星体
    expect(target.querySelectorAll("g.affiliated-badge").length).toBe(0);
    expect(target.querySelector("aside.affiliated-aside")).toBeNull();
    done();
  });
});

// 1.4.2 容器看板/实例色/选中类：同 kind 多容器实例的区分度与互斥选中
const boardCatalog: Catalog = {
  modules: [{ id: "wf", namespace: "wf", version: "1.0.0" }],
  kinds: [
    { kind: "wf.domain", owner: "wf", represent: "container" },
    { kind: "wf.task", owner: "wf" },
  ],
  commands: [],
};

const boardSnapshot: GraphSnapshot = {
  graphId: "multi",
  revision: 1,
  objects: [
    obj("demo-domain", "wf.domain", "演示域"),
    obj("domain-alpha", "wf.domain", "域Alpha"),
    obj("domain-beta", "wf.domain", "域Beta"),
    obj("t-1", "wf.task", "任务一"),
    obj("t-2", "wf.task", "任务二"),
    obj("t-3", "wf.task", "任务三"),
    obj("t-4", "wf.task", "任务四"),
    obj("t-5", "wf.task", "任务五"),
    obj("t-6", "wf.task", "任务六"),
  ],
  relations: [
    rel("m-1", "member_of", "t-1", "demo-domain"),
    rel("m-2", "member_of", "t-2", "demo-domain"),
    rel("m-3", "member_of", "t-3", "domain-alpha"),
    rel("m-4", "member_of", "t-4", "domain-alpha"),
    rel("m-5", "member_of", "t-5", "domain-beta"),
    rel("m-6", "member_of", "t-6", "domain-beta"),
  ],
};

describe("GraphCanvas 容器看板/实例色/选中类（1.4.2）", () => {
  afterEach(() => {
    store.snapshot = null;
    store.selection = null;
    store.selectedContainerId = null;
    store.searchQuery = "";
    store.kindFilter = "";
    store.catalog = null;
  });

  it("实例色（R1）：同 kind 多容器的色点按容器 id 确定性哈希配色且互不相同", async () => {
    store.catalog = boardCatalog;
    loadSnapshot(boardSnapshot);
    const { target, done } = await mountCanvas();

    const dots = [...target.querySelectorAll<SVGCircleElement>("g.container-header circle.container-dot")];
    expect(dots.length).toBe(3);
    // 确定性：与 moduleProjection 的哈希回退色一致（DOM 顺序 = objects 顺序）
    const fills = dots.map((dot) => dot.getAttribute("fill"));
    expect(fills).toEqual(["demo-domain", "domain-alpha", "domain-beta"].map((id) => fallbackKindColor(id)));
    // 区分度：同 kind 三个实例三色
    expect(new Set(fills).size).toBe(3);
    done();
  });

  it("看板投影（R2）：3 容器 → 3 行（实例色点/标题/计数/折叠态/按钮），色点与画布 dot 同色", async () => {
    store.catalog = boardCatalog;
    loadSnapshot(boardSnapshot);
    const { target, done } = await mountCanvas();

    const board = target.querySelector("section.container-board");
    expect(board).not.toBeNull();
    const rows = [...target.querySelectorAll<HTMLElement>(".container-row")];
    expect(rows.length).toBe(3);
    // 行序 = 容器 id 字典序：demo-domain / domain-alpha / domain-beta
    expect(rows.map((row) => row.querySelector(".row-title")?.textContent)).toEqual(["演示域", "域Alpha", "域Beta"]);
    // 实例色点与画布 dot 同源（containerColorOf）；jsdom 把 style 里的 hex 规范化为 rgb()
    const hexToRgb = (hex: string): string => {
      const value = hex.replace("#", "");
      return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`;
    };
    const canvasDots = [...target.querySelectorAll<SVGCircleElement>("g.container-header circle.container-dot")].map(
      (dot) => dot.getAttribute("fill"),
    );
    rows.forEach((row, index) => {
      expect(row.querySelector(".row-dot")?.getAttribute("style")).toContain(hexToRgb(canvasDots[index]!));
    });
    expect(rows.every((row) => row.querySelector(".row-count")?.textContent === "2")).toBe(true);
    expect(rows.every((row) => row.querySelector(".row-state")?.textContent === "折叠")).toBe(true);
    expect(rows.every((row) => row.querySelector(".row-toggle")?.textContent?.trim() === "展开")).toBe(true);
    done();
  });

  it("看板行点击（R3/R4）：选中该类 + 定位请求带锚点偏移；成员光晕随选中类；选类清节点选中", async () => {
    store.catalog = boardCatalog;
    loadSnapshot(boardSnapshot);
    const { target, done } = await mountCanvas();

    const rows = [...target.querySelectorAll<HTMLElement>(".container-row")];
    (rows[0].querySelector(".container-row-main") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();
    expect(store.selectedContainerId).toBe("demo-domain");
    expect(store.selection).toBeNull(); // 选类清节点选中
    expect(store.locateRequest?.nodeId).toBe("demo-domain");
    expect(typeof store.locateRequest?.offsetX).toBe("number"); // 局部锚点偏移（折叠条中心 = 0 偏移）
    // 类成员光晕（R4b）：2 个成员加实例色样式变量
    const glowing = [...target.querySelectorAll<SVGGElement>("g.node.is-class-glow")];
    expect(glowing.length).toBe(2);
    expect(glowing.every((node) => (node.getAttribute("style") ?? "").includes(fallbackKindColor("demo-domain")))).toBe(true);

    // 展开后行点击 → 偏移 = 框中心（数值随成员位置变化，这里只断言已携带）
    (rows[0].querySelector(".row-toggle") as HTMLButtonElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    (rows[0].querySelector(".container-row-main") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();
    expect(typeof store.locateRequest?.offsetX).toBe("number");
    expect(typeof store.locateRequest?.offsetY).toBe("number");

    // 选中互斥：点节点清类选中（store.select 中枢）
    const node = target.querySelector("g.node") as SVGGElement;
    (node.querySelector(".node-hit-area") as SVGRectElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selectedContainerId).toBeNull();
    expect(store.selection).toEqual({ type: "object", id: "t-1" }); // 节点层首个星体 = t-1
    expect(target.querySelectorAll("g.node.is-class-glow").length).toBe(0);
    done();
  });

  it("抽屉打开时看板整栈让位（回归）：selection 翻转让位类，行点击在让位态仍命中，关抽屉回位", async () => {
    store.catalog = boardCatalog;
    loadSnapshot(boardSnapshot);
    const { target, done } = await mountCanvas();

    const stack = target.querySelector(".right-stack") as HTMLElement;
    // 抽屉关闭：不让位
    expect(stack.classList.contains("drawer-shifted")).toBe(false);

    // 选中节点（App 外壳据此打开右缘详情抽屉）→ 整栈左移让位
    const node = target.querySelector("g.node") as SVGGElement;
    (node.querySelector(".node-hit-area") as SVGRectElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "t-1" });
    expect(stack.classList.contains("drawer-shifted")).toBe(true);

    // 让位态下看板行仍可命中：点行 = 选类（互斥清节点选中）+ 定位请求
    const rows = [...target.querySelectorAll<HTMLElement>(".container-row")];
    (rows[1].querySelector(".container-row-main") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();
    expect(store.selectedContainerId).toBe("domain-alpha");
    expect(store.locateRequest?.nodeId).toBe("domain-alpha");

    // 关抽屉（清选中）→ 回位
    store.select(null);
    await tick();
    expect(store.selection).toBeNull();
    expect(stack.classList.contains("drawer-shifted")).toBe(false);
    done();
  });
});
