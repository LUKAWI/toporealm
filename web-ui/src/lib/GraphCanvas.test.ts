import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import GraphCanvas from "./GraphCanvas.svelte";
import { store } from "./store.svelte";
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

    // 容器：独立分区层，不进星体层
    const containers = target.querySelectorAll("g.container-group");
    expect(containers.length).toBe(1);
    expect(labelsOf(target, "g.container-group")[0]).toContain("容器一");
    expect(labelsOf(target, "g.node").join("\n")).not.toContain("容器一");
    // 普通星体 = 4（t-1/t-2/plain-1/plain-2）；标注与容器不画星体
    expect(target.querySelectorAll("g.node").length).toBe(4);

    // 标题 = displayOf(object)；默认折叠 + 成员计数徽章（t-1/t-2/rep-4 共 3 个成员）
    expect(containers[0].querySelector(".container-title")?.textContent).toBe("容器一");
    expect(containers[0].classList.contains("collapsed")).toBe(true);
    expect(containers[0].classList.contains("expanded")).toBe(false);
    expect(containers[0].getAttribute("aria-expanded")).toBe("false");
    expect(containers[0].querySelector(".container-count")?.textContent).toBe("3");

    // member_of 不画线（容器已表达）；标注参与的 report_of 也不画（标注不是星体）；
    // 普通星体关系照常画线（dep-1 一条）
    expect(target.querySelectorAll("g.edge-group").length).toBe(1);
    done();
  });

  it("点击容器条展开/收起（aria-expanded 同步）", async () => {
    store.catalog = layeredCatalog;
    loadSnapshot(layeredSnapshot);
    const { target, done } = await mountCanvas();

    const container = target.querySelector("g.container-group") as SVGGElement;
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("expanded")).toBe(true);
    expect(container.getAttribute("aria-expanded")).toBe("true");

    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.classList.contains("collapsed")).toBe(true);
    expect(container.getAttribute("aria-expanded")).toBe("false");
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

    const container = target.querySelector("g.container-group") as SVGGElement;
    store.kindFilter = "wf.task";
    await tick();
    // 成员被过滤时容器计数同步：3 个成员只剩 t-1/t-2（rep-4 是 wf.report）
    expect(container.querySelector(".container-count")?.textContent).toBe("2");

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
