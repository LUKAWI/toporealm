// M4 安装器 fixture：npm 包形态的 v2 模块（npm pack --ignore-scripts → 安装 → daemon 装载）。
// activate 最小化：注册一个只读全局命令，证明「安装 → 装载 → 目录可见」全链路。
export default {
  activate(api) {
    api.command(
      {
        name: "count-cards",
        title: "统计图中 cards.card 对象数量（安装器 fixture 的自检命令）",
      },
      () => {
        const n = api.byKind("cards.card").length;
        return { message: `${n} card(s)` };
      },
    );
  },
};
