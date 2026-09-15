import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CoreError } from "./core/errors.js";

export interface ProductIdentity {
  readonly packageName: "@lukawi/toporealm";
  readonly version: string;
  readonly channel: "preview";
  readonly cliName: "toporealm";
  readonly mcpServerName: "toporealm";
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  publishConfig?: { tag?: unknown };
  bin?: Record<string, unknown>;
}

/** Read-only adapter over the package-root manifest, in source, dist and installed layouts. */
export function readProductIdentity(manifestPath = fileURLToPath(new URL("../package.json", import.meta.url))): ProductIdentity {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const cliName = manifest.bin ? Object.keys(manifest.bin)[0] : undefined;
  if (manifest.name !== "@lukawi/toporealm" || typeof manifest.version !== "string" || manifest.publishConfig?.tag !== "preview" || cliName !== "toporealm") {
    throw new CoreError({ code: "INVALID_PRODUCT_IDENTITY", message: "package.json 缺少有效的 TopoRealm Product Identity。" });
  }
  return Object.freeze({ packageName: manifest.name, version: manifest.version, channel: manifest.publishConfig.tag, cliName, mcpServerName: "toporealm" });
}

export const PRODUCT_IDENTITY = readProductIdentity();
