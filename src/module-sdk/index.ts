import type { ModuleId, ModuleNamespace } from "../core/index.js";

export interface ModuleManifest {
  format: "toporealm.module/v1alpha1";
  id: ModuleId;
  namespace: ModuleNamespace;
  version: string;
  supports: { schemas: number[] };
}

export interface ModuleSurface {
  readonly name: "module-sdk";
  readonly manifestFormat: ModuleManifest["format"];
}

export const moduleSurface: ModuleSurface = {
  name: "module-sdk",
  manifestFormat: "toporealm.module/v1alpha1",
};
