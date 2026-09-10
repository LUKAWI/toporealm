# TopoRealm

**An extensible, visual, agent-friendly local graph workspace.**

TopoRealm provides a stable foundation for graph storage, versioned mutations, CLI, MCP, and a Web UI. Domain behavior arrives through modules that users install explicitly. It is for people who want humans and agents to share one local source of truth without baking task, research, or learning semantics into Core.

> `0.1.0` is a public Preview. The graph and module protocols are frozen at v1, but the npm package ships with no domain modules. `research`, `exploration`, and `workflow` currently exist only as non-release test fixtures. They will be developed independently after v0.1 and must pass standalone connection tests and multi-module composition tests before release.

[中文](README.md) · [Architecture boundary](docs/architecture/FOUNDATION.md) · [Module contract](docs/architecture/module-contract.md) · [Release checklist](docs/releases/v0.1.0-preview.md)

## What is included

- **Core:** local YAML graphs, stable IDs, revisions, atomic mutations, conflict handling, undo/redo, and base/full validation.
- **Web UI:** canvas, search, graph switching, generic editing, history, module status, and declarative module styling and forms.
- **CLI and stdio MCP:** humans and agents use the same Core; MCP exposes fixed graph, validation, history, module, and action entry points.
- **Module ecosystem:** install, bind, activate per graph, registry snapshots, lossless reads without a module, `MutationPlan` actions, and uninstall.
- **Four base Skills:** `toporealm`, `toporealm-design`, `toporealm-join`, and `toporealm-grilling`.
- **Three host projections:** directly usable manifests, Skills, MCP configuration, and read-only onboarding hooks for Codex, Claude Code, and Pi.

## Start in five minutes

Node.js 20 or newer is required.

```bash
npm install --global @lukawi/toporealm@preview

mkdir my-realm
cd my-realm
toporealm init demo
toporealm status
toporealm serve --open
```

`serve` prints the local URL. Without `--open`, open that URL manually. TopoRealm discovers `.toporealm/` by walking upward; `--root <directory>` and `--graph <graph-id>` select targets explicitly.

```bash
toporealm list
toporealm switch demo
toporealm read
toporealm validate
toporealm validate --complete
toporealm undo
toporealm redo
```

## Connect an agent through MCP

Any stdio MCP host can launch TopoRealm with:

```json
{
  "mcpServers": {
    "toporealm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@lukawi/toporealm@0.1.0", "mcp"]
    }
  }
}
```

Inside a workspace, `toporealm mcp` starts the same server directly. Its fixed tools are `graph_list`, `graph_read`, `graph_create`, `graph_select`, `graph_validate`, `graph_apply`, `graph_undo`, `graph_redo`, `module_status`, `action_list`, and `action_execute`.

## Install modules and sync hosts

Modules are independent npm packages, not hidden built-ins:

```bash
toporealm module add <npm-package-or-local-path>
toporealm module list
toporealm host sync
```

`host sync` creates TopoRealm-owned assets under `.codex/`, `.claude/`, and `.pi/` in the current workspace and preserves user files without a TopoRealm ownership marker. If a module is removed, its data remains losslessly readable, but domain-level full validation is unavailable.

### Module trust boundary

v0.1 loads only trusted local code that the user explicitly installs. It does not provide a third-party code sandbox or remote module marketplace. A module may provide domain operation implementations invoked by Core, but it has no graph-storage write access. Every graph change must be returned to Core as a `MutationPlan` for validation and commit. Core is the only component allowed to write graph facts through the supported contract.

## Base Skills

| Skill | Purpose |
|---|---|
| `toporealm` | Identifies the workspace, graph, and modules, then routes the request to the foundation or a module Skill. |
| `toporealm-design` | Designs domain-neutral objects, relations, capability composition, layers, and readability. |
| `toporealm-join` | Gives a new session a read-only view of scope, modules, key objects, and recent changes. |
| `toporealm-grilling` | Aligns requirements and intent, asking one focused question at a time when a critical product or protocol ambiguity remains. |

These Skills do not decide domain objects, lifecycles, or completion rules on behalf of a domain module.

## Use TopoRealm as a library

```ts
import { GraphStore } from "@lukawi/toporealm/core";
import type { MutationPlan } from "@lukawi/toporealm/module-sdk";
```

Public subpaths also include `cli`, `mcp`, `server`, `web`, and `distribution`. See [CONTEXT.md](CONTEXT.md) for the shared vocabulary and the [v1 freeze](docs/architecture/v1-freeze.md) for stable contracts.

## Develop and verify

```bash
npm install
npm --prefix web-ui install
npm run verify
git diff --check
```

`npm run verify` covers type checking, Core/CLI/MCP/module/host tests, Web type and component tests, and CLI/MCP/Web smoke tests from an installed npm tarball. CI runs the same gate on Node.js 20 across Windows, macOS, and Linux.

## License

[MIT](LICENSE)
