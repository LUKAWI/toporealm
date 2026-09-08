import type { ModuleId, ModuleNamespace } from "../core/index.js";

export type ModuleFormat = "toporealm.module/v1alpha1";

export interface ContributionRef {
  id: string;
  schema?: string;
  declaration?: string;
}

export interface ModuleDependency {
  id: ModuleId;
  version: string;
}

export interface ModuleManifest {
  format: ModuleFormat;
  id: ModuleId;
  namespace: ModuleNamespace;
  version: string;
  supports: { schemas: number[] };
  requires?: { modules?: ModuleDependency[] };
  contributes?: {
    object_kinds?: ContributionRef[];
    relation_kinds?: ContributionRef[];
    capabilities?: ContributionRef[];
    validators?: ContributionRef[];
    operations?: ContributionRef[];
  };
  runtime?: { entry: string };
  ui?: { contribution: string };
  skills?: { directory: string };
}

export interface ModuleSurface {
  readonly name: "module-sdk";
  readonly manifestFormat: ModuleManifest["format"];
}

export const moduleSurface: ModuleSurface = {
  name: "module-sdk",
  manifestFormat: "toporealm.module/v1alpha1",
};

export * from "./registry.js";
export * from "./actions.js";
