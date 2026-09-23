import type { EntityId, Kind } from "./entities.js";

// ---------- id/kind 校验 + did-you-mean（纯函数；blueprint §1/§4） ----------

/**
 * EntityId 磁盘文件名安全（Windows 优先）：禁 / \ : 与控制字符；
 * 另禁 . .. 与 Windows 保留设备名（CON.yaml 之类在 Windows 上不可创建）。
 */
export function isValidEntityId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return false;
  if (id === "." || id === "..") return false;
  if (/[/\\:\x00-\x1f]/.test(id)) return false;
  if (id !== id.trim()) return false;
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(id)) return false;
  return true;
}

/** 主类型：非空、无空白、无文件名非法字符；无点号 = 公共/无主。 */
export function isValidKind(kind: string): boolean {
  if (typeof kind !== "string" || kind.length === 0 || kind.length > 200) return false;
  if (/[\s/\\:\x00-\x1f]/.test(kind)) return false;
  return true;
}

/** kind 的模块命名空间前缀；无点号 = null（公共/无主）。 */
export function kindNamespace(kind: Kind): string | null {
  const idx = kind.indexOf(".");
  return idx > 0 ? kind.slice(0, idx) : null;
}

/** graphId：成为目录名，规则同 EntityId。 */
export const isValidGraphId = isValidEntityId;

/** Levenshtein 编辑距离（阈值用）。 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const up = (prev[j] ?? 0) + 1;
      const left = (curr[j - 1] ?? 0) + 1;
      const diag = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(up, left, diag);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? Math.max(m, n);
}

/** did-you-mean：返回按距离升序的候选（距离 ≤ max(2, len/3)），无匹配返回空。 */
export function suggestClosest(
  input: string,
  candidates: readonly string[],
  limit = 3,
): string[] {
  const threshold = Math.max(2, Math.floor(input.length / 3));
  const scored: { c: string; d: number }[] = [];
  for (const c of candidates) {
    const d = editDistance(input.toLowerCase(), c.toLowerCase());
    if (d <= threshold) scored.push({ c, d });
  }
  scored.sort((x, y) => x.d - y.d);
  return scored.slice(0, limit).map((s) => s.c);
}
