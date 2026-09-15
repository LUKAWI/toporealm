import { CoreError } from "./errors.js";
import type { LegacyGraphReader } from "./managed.js";
import { GraphStore } from "./store.js";
import type { GraphValidationResult } from "./validate.js";
import { validateGraph } from "./validate.js";

const WRITE_METHODS = new Set(["commit", "apply", "undo", "redo", "initialize", "write"]);

/** Opens a 0.2.x read-only bridge for existing toporealm.graph/v1 directories. */
export function openLegacyGraph(graphRoot: string): LegacyGraphReader {
  const store = new GraphStore(graphRoot);
  const reader: LegacyGraphReader = {
    read: () => store.read(),
    validate: (): GraphValidationResult => {
      const result = validateGraph(store.read());
      return {
        ...result,
        complete: false,
        warnings: [...result.warnings, {
          code: "LEGACY_READ_ONLY",
          message: "当前图通过 /core/legacy 只读兼容桥打开；请迁移到 ManagedGraph 后再写入。",
          severity: "warning",
        }],
      };
    },
  };
  return new Proxy(reader, {
    get(target, property, receiver) {
      if (typeof property === "string" && WRITE_METHODS.has(property)) {
        return () => { throw new CoreError({ code: "LEGACY_WRITE_UNSUPPORTED", message: `legacy 只读桥不支持 ${property}；请改用 ManagedGraph。` }); };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
