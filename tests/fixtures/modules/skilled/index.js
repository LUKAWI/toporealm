// M5 host sync fixture：携带模块自身 skills 的 v2 模块（投影由 host sync 交付，装载面不读）。
export default {
  activate(api) {
    api.command({ name: "ping", title: "回声（skills 投影 fixture 自检命令）" }, () => ({ message: "pong" }));
  },
};
