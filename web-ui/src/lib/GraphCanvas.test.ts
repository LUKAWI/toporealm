import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphCanvas from "./GraphCanvas.svelte";
import { store } from "./store.svelte";
import { seedGridLayout } from "./layout";
import type { Catalog, GraphSnapshot } from "./protocol";
import { obj, rel } from "./test-support";

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

  it("点击容器条展开/收起（底板与头部条 aria/类同步）", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    const header = target.querySelector("g.container-header") as SVGGElement;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);
    expect(header.classList.contains("expanded")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(header.classList.contains("collapsed")).toBe(true);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    done();
  });

  it("展开分区几何以容器局部坐标包围成员星体（底板不叠加容器自身位移），收起再展开可靠", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(Number(body().getAttribute("width"))).toBe(132); // 折叠条宽度 = barWidth
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);

    // 展开态命中区覆盖框顶行：成员角标与标题同点时命中头部条 → 可靠收起
    const hit = header.querySelector(".container-header-hit") as SVGRectElement;
    expect(Number(hit.getAttribute("width"))).toBeGreaterThan(0);
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);

    // 键盘路径不回归：Enter 仍可在头部条上切换展开
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);
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
    header.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("点击容器展开/收起不清空已有选中（空白清除不误伤容器）", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    store.select({ type: "object", id: "t-1" });
    await tick();
    const container = target.querySelector("g.container-group") as SVGGElement;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);
    expect(store.selection).toEqual({ type: "object", id: "t-1" });

    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(store.selection).toEqual({ type: "object", id: "t-1" });
    done();
  });

  it("Esc 命中聚焦容器时收起展开分区；Esc 不聚焦容器时不动展开状态", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
