// ---------- 共享测试夹具助手（批次 D：四份复制的 bindingYaml 合一） ----------

/** 绑定表 → modules.yaml 文本（path 来源；JSON 双引号写法兼容 Windows 反斜杠路径） */
export function bindingYaml(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      .map(([id, dir]) => `${id}:\n  source: path\n  path: ${JSON.stringify(dir)}`)
      .join("\n") + "\n"
  );
}
