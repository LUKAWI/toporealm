# TopoRealm

**An agent-first, local-first graph workspace: a minimal core (single-owner daemon + CLI + realtime WebUI) with a highly customizable two-layer module system.**

One local graph, written and read by humans and agents together: people work in the terminal and the browser, agents work through the CLI and skills — everything lands on the same resident daemon, where every change is seen live by everyone, undoable, and auditable.

Design inspired by [pi](https://github.com/badlogic/pi-mono): the smallest possible core, systematic extensions, and one local graph shared by humans and agents.

## Install

```bash
npm install -g @lukawi/toporealm        # two bins: toporealm (CLI) + toporeald (daemon)
```

Requires Node ≥ 22 (WS transport needs the global WebSocket). For third-party integrations, install `@lukawi/toporealm-client` on its own.

## Quick start

```bash
toporealm init                         # initialize the workspace (.toporealm + global pool + AGENTS.md hint)
toporealm creategraph mygraph
toporealm add wf.task --id t-1 --payload '{"title":"Write blueprint","status":"todo"}'
toporealm add wf.task --id t-2 --payload '{"title":"Review blueprint"}'
toporealm link t-1 t-2 --kind wf.blocks
toporealm find status=todo             # shallow payload equality search
toporealm set t-1 status=doing         # daemon-side shallow merge; k=null deletes a key
toporealm serve                        # open the WebUI: live sync, no refresh
toporealm undo                         # everything is undoable (external edits included)
```

The daemon is transparently spawned on first contact and exits when idle; browsers and multiple terminal sessions on the same graph stay in sync in real time.

## Install a domain module, get commands

```bash
toporealm module add --global @lukawi/toporealm-workflow   # global pool (all projects; omit --global for this project only)
toporealm cmds                                     # introspect: wf.* commands become top-level subcommands
toporealm wf.create-task --input '{"title":"First task"}'
toporealm skills index                             # module skill index (agents Read the SKILL.md paths)
```

Module skills are never copied or projected: skill files live only in the pools — Claude Code
consumes them via the marketplace plugin's SessionStart hook (`claude plugin marketplace add
LUKAWI/toporealm` → `plugin install toporealm`); Pi discovers them natively through the
aggregate package's built-in extension (`pi install npm:@lukawi/toporealm`).

Modules are two-layer: `module.yaml` declares identity/namespace/vocabulary (coordination), `activate(api)` registers commands, forms and hooks (behavior). The core enforces exactly two rules — the **ownership rule** (a module may only touch kinds in its own namespace) and the **dangling-relation check**; all domain rules live in module before-commit hooks (with before/after snapshots, named veto against changes from any origin). To write your own module, install [`@lukawi/toporealm-module-sdk`](https://www.npmjs.com/package/@lukawi/toporealm-module-sdk) and follow the types.

## For agents

- Every command speaks a constant `--json` envelope (success: `data/revision/instanceId`; failure: `code/message/hint/fix`), exit codes `0/1/2`, copy-pasteable fix commands, and did-you-mean on mistyped ids.
- Agent main-path budget: `status → find → set → link → set → log` ≈ 6 commands.
- Module skill index: `toporealm skills index` (Claude Code receives it automatically via the SessionStart hook).

## Architecture & docs

One sentence: **humans via CLI, agents via CLI+skills, browsers via WS — all hitting a single-owner daemon; modules are two-layer extensions loaded into the daemon; the core enforces exactly two rules.**

Primary documentation is in Chinese: [blueprint](docs/rebuild/blueprint.md) (implementation spec) · [glossary](CONTEXT.md) · [ADRs](docs/adr/) · [project status](docs/PROJECT-STATUS.md) · [design philosophy](Toporealm设计构想.md) · [CHANGELOG](CHANGELOG.md).

> **Library consumers**: the `-*` subpackages currently ship TS sources directly (`main`/`exports` point at `src/*.ts`); consuming them as libraries requires TS runtime support. The CLI/daemon bins bundle tsx loading and work out of the box.
>
> **0.x is archived**: npm `@lukawi/toporealm@preview` (up to 0.1.3) is frozen; code and docs remain on the `v0.1.x` tags and [GitHub Releases](https://github.com/LUKAWI/toporealm/releases). Old graphs migrate via `toporealm migrate`.

## License

[MIT](LICENSE)
