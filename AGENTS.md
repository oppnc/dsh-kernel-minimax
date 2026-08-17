# AGENTS.md — Maintainer Guide

Verbose engineering notes for `dsh-kernel-minimax`. This package is "Mini-Agent
written in DSH form": the MiniMax Mini-Agent
(https://github.com/MiniMax-AI/Mini-Agent) tool surface re-registered as DSH
tools with identical names and schemas, implemented on DSH services so the
surface survives `toolFilter` scoping.

## What this package is

A DSH agent on the `minimax-kernel` model route should see the same tool names,
JSON schemas, and semantics as a native Mini-Agent run — but backed by DSH
services (`fs`, `subprocess`, `jobs`) instead of Mini-Agent's Python runtime.
Schemas are distilled from `mini_agent/tools/*.py`, where each tool is a `Tool`
subclass carrying a `parameters` JSON Schema.

The plugin is a Cordis plugin object:

```js
export const name = 'dsh-kernel-minimax'
export const inject = ['fs', 'tools', 'subprocess', 'jobs']
export async function apply(ctx) { /* registers every tool */ }
```

`inject` is the Cordis **hard-dependency barrier** (mesh AGENTS.md §2): Cordis
will not call `apply()` until every listed service is ready. Only services the
plugin cannot start without — `fs`, `tools`, `subprocess`, `jobs` — belong
there. Optional services (`sandboxPolicy`) are read with `ctx.get(...)` and
guarded against `undefined`. Never read an undeclared service as a bare
`ctx.<name>` property. If `tools` or `fs` is missing the plugin returns early
and registers nothing. `subprocess` / `jobs` are still hard-injected so boot
waits for them, but `execute` re-checks `ctx.get(...)` and degrades to an
in-tool error string if they are torn down mid-run.

Every registration (`tools.register`) and the in-memory `noteStore` live inside
`apply()` and are bound to the plugin fiber. There are no module-level side
effects. Stopping or updating the row disposes the tools and the note map.

## Tool inventory and schema provenance

| Tool | Upstream source | Provenance notes |
| --- | --- | --- |
| `read_file` | `mini_agent/tools/file_tools.py` — `ReadTool` | `path` (required), `offset`, `limit`. Output is line-numbered `LINE_NUMBER\|LINE_CONTENT`, 1-indexed, matching Mini-Agent's format. |
| `write_file` | `mini_agent/tools/file_tools.py` — `WriteTool` | `path`, `content` both required. Full overwrite semantics. |
| `edit_file` | `mini_agent/tools/file_tools.py` — `EditTool` | `path`, `old_str`, `new_str` with exact-match, must-be-unique rules preserved. |
| `bash` | `mini_agent/tools/bash_tool.py` — `BashTool` | `command` (required), `timeout` (default 120 s, max 600 s, foreground only), `run_in_background`. |
| `bash_output` | `mini_agent/tools/bash_tool.py` — `BashOutputTool` | `bash_id` (required), `filter_str` (regex). Incremental output since last read. |
| `bash_kill` | `mini_agent/tools/bash_tool.py` — `BashKillTool` | `bash_id` (required). Graceful-then-force termination via `jobs.kill`. |
| `get_skill` | `mini_agent/tools/skill_tool.py` (+ `skill_loader.py`) | `skill_name` (required). Returns full SKILL.md body. |
| `list_skills` | `skill_loader.py` (inferred — see honesty flags) | No parameters. Lists skill `name` + `description`. |
| `record_note` | `mini_agent/tools/note_tool.py` — `SessionNoteTool` | `content` (required), `category`. Timestamped session notes. |
| `recall_notes` | `mini_agent/tools/note_tool.py` — `RecallNoteTool` | `category` (optional filter). Returns all recorded notes. |

There is **no subagent / Agent / task tool**. Mini-Agent's native surface has
none, and this package must not invent one. Mesh L2 still exposes a
`minimax-agent` recipe via `kernel_run` in `dsh-kernel-mesh`; that is a mesh
concern, not a Mini-Agent surface tool.

## Honesty flags (approximations and omissions)

These are things a maintainer must NOT "fix" blindly — each is a deliberate,
documented divergence from upstream.

1. **`list_skills` is inferred as a tool.** Upstream Mini-Agent does not expose a
   standalone `list_skills` tool. Instead, the skill loader injects the list of
   skill names + descriptions directly into the system prompt as metadata
   (`skill_loader.py` builds that prompt block). DSH has no equivalent
   "inject into system prompt from a plugin" hook that we can rely on here, so
   `list_skills` is registered as a real tool that scans the skills tree on
   demand. It is functionally equivalent, but it is an *addition* to the native
   tool surface, not a mirror.

2. **`recall_notes` is defined but not wired upstream.** Mini-Agent's
   `RecallNoteTool` exists in `note_tool.py` but is not actually registered into
   the upstream agent's tool list. We register it anyway so the note surface is
   complete and self-consistent (`record_note` without recall would be
   pointless).

3. **MCP tools are intentionally omitted.** Mini-Agent names MCP tools
   *dynamically* at load time: each configured MCP server's tool list is
   enumerated in `mcp_loader.py` and tools are registered under those
   server-derived names. There is no fixed schema to mirror, so wiring them in
   DSH form is out of scope for this package. A future release could map a
   DSH-side MCP provider onto the same `mcp__<server>__<tool>` naming
   convention if one becomes available.

4. **`globToRegex` is carried but currently unused.** The Mini-Agent `EditTool`
   supports glob-pattern matching in some versions; we keep the helper handy
   but `edit_file` uses exact-match (unique) semantics, matching the distilled
   schema.

5. **No subagent tool.** Mini-Agent has no delegation primitive. Do not add
   `subagent` / `Agent` / `task` here even though mesh gap #5 (continuable
   children) is resolved in `dsh-kernel-mesh`. If a MiniMax session needs a
   child, use the mesh `kernel_run` / stock `subagent` path — not this surface.

## Implementation decisions

- **Filesystem is `fs` + policy passthrough.** `read_file`/`write_file`/
  `edit_file` resolve paths against the sandbox workspace root
  (`sandboxPolicy.workspaceRoot`) and pass `sandboxPolicy.resolve()` as the 5th
  argument to `fs.writeText`/`fs.editText` so the running session's file policy
  is honored. Without that passthrough, writes were denied by the sandbox.
  `read_file` operates on text only (`fs.readText`) and numbers lines
  `LINE_NUMBER|LINE_CONTENT` after dropping a trailing empty split (Python
  `readlines()`/`rstrip` semantics).

- **`bash` is `subprocess` + `jobs`, not a real shell name.** DSH has no `bash`
  service; the equivalent is `subprocess.spawn` with the built-in `jobs`
  registry for background handles. `bash` maps to a **PowerShell** invocation
  (historical Windows-host assumption in this family of plugins), not POSIX
  bash. We resolve `pwsh.exe` via `subprocess.resolveExecutable` and fall back
  to an absolute `powershell.exe` path (`C:\Windows\System32\...`) when PATH
  resolution fails (a historical bug: the sanitized PATH made the bare name
  ENOENT). On a Linux/WSL host that fallback is a documented host-shape
  leftover; `resolveExecutable('pwsh.exe')` is the real lookup.

  Foreground timeout is **honest**: default 120 s, clamped to `[1, 600]`
  seconds, matching the tool description. There is no hidden wall-clock cap
  below 600 s. After a timeout, `handle.terminate()` is called and the tool
  waits up to 4 s (or until `exec.signal` aborts) for collected output — that
  4 s is teardown, not a second command budget. Background jobs carry **no**
  `exec.signal`; only `bash_kill` (`jobs.kill` → `handle.terminate`) may stop
  them. Spawn happens **inside** `jobs.start({ run })` so a preflight failure
  cannot leak a live process tree. `bash_output` uses the jobs consuming
  cursor (`jobs.read`); `filter_str` is applied to the delta.

- **Skills are scanned from a Mini-Agent `skills/` tree.** `SKILLS_ROOT`
  defaults to a historical absolute Windows path and is overridable via
  `DSH_MINIMAX_SKILLS_ROOT`. `discoverSkills()` walks the tree recursively
  (skipping `node_modules`, `.git`, `.dsh`, `.venv`, `__pycache__`, `dist`),
  finds every `SKILL.md`, and parses the `name`/`description` YAML frontmatter
  — mirroring `skill_loader.load_skill`'s required-field contract (a skill
  with no name or no description is skipped). `get_skill` then strips the
  frontmatter and reports the skill root as the directory *containing* that
  `SKILL.md`. The hardcoded default remains the biggest portability liability;
  the env var is the supported override.

- **Notes live in a plugin-local in-memory store.** `record_note` /
  `recall_notes` push into a `noteStore` `Map` created inside `apply()` and
  keyed by `exec.agent.session.id` so concurrent sessions never share notes.
  Upstream Mini-Agent persists notes to disk in its own session directory; we
  deliberately keep notes in-memory because DSH sessions own their lifecycle,
  and this package does not yet define a stable on-disk note location.
  Persisting across sessions is a candidate follow-up.

## DSH `ToolDefinition` contract

Each tool is registered via `tools.register(t)` where `t` satisfies the DSH
`ToolDefinition` shape (mesh AGENTS.md §3.4):

- `name` — the tool name the model sees.
- `description` — free-text guidance (copied/adapted from upstream docstrings).
- `parameters` — a JSON Schema object describing the arguments.
- `output` — `{ schema, render }` **both required**. `output.schema` is an
  *enforced subset*: only declared fields reach the model/UI. Every tool here
  goes through `strDef`, which sets `output.schema = { type: 'string' }` plus
  a text `render(a, v) => [{ type: 'text', text }]`. Treat a missing `render`
  as a bug, not something the mesh fallback should paper over.
- `execute(args, exec)` — async handler; `exec.signal` is used for
  cancellation, and `exec.agent` is used as the `owner` of background jobs.

## Known gaps

- **No Mini-Agent subagent tool.** Deliberate absence (honesty flag 5). Mesh
  gap #5 is resolved *in the mesh*; this surface does not consume it.
- **MCP / dynamic tools omitted** — no fixed schema to mirror.
- **Skills default path is host-specific.** Override with
  `DSH_MINIMAX_SKILLS_ROOT`.
- **Notes are process-lifetime only.** Fiber-scoped `Map`, not disk.
- **`bash` is PowerShell-shaped.** Command strings are `-Command` to
  `pwsh`/`powershell`, not `/bin/bash -lc`.

### Mesh gaps this surface inherits (current truth)

These live in `dsh-kernel-mesh` AGENTS.md §7 and are **not** open work for this
package unless noted:

- **§7.1 Kimi thinking signature side-table** — Kimi-only; unused here.
- **§7.2 Grok reasoning replay** — Grok/Responses-wire; unused here.
- **§7.3 MiniMax needs an API key.** `minimax-kernel` only registers when an
  `api_key` (`sk-...`) is present in `~/.mini-agent/config.yaml` (fallback
  `~/.config/mini-agent/config.yaml`). No key → no L1 route, and
  `kernel_switch('minimax')` reports unknown/unavailable only at resolve time.
  This surface still mounts and registers its ten tools without a key; only
  the *model route* is dormant. That is the mesh-owned gate for this plugin's
  kernel.
- **§7.4 `loop_control` has no DSH knob.** Kimi-origin; Mini-Agent has no
  equivalent. Alignment remains documentation-level until the harness exposes
  the knob.
- ~~**§7 #5 continuable subagents.**~~ **RESOLVED** in the mesh
  (`subagents.startContinuable`). This surface has no subagent tool, so it
  does not call that route.
- ~~**§7 #6 non-streaming transports.**~~ **RESOLVED** in the mesh: both
  adapter factories stream real SSE (`stream: true`, curl `-N`) with JSON
  auto-fallback. This surface has no transport of its own.
- ~~**Adapter error classification.**~~ **RESOLVED** in the mesh: adapters
  throw with canonical own-property codes (`e.code` + `e.failure`) so
  `dsh-llm-retry` retries `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`.
  This surface does not throw adapter errors.
- **§7.7 Responses-wire images remain upstream-blocked.** MiniMax itself is
  Anthropic-wire and *does* resolve DSH `image` blocks in the mesh adapter.
  This surface still has no image tool (Mini-Agent has none).

## Testing notes

- **Syntax:** `node --check lib/index.js` on every change; the file is plain
  ESM (`type: module`) with no build step.
- **Surface smoke:** `/tmp/kernel-surfaces-smoke-minimax.js` (mock-ctx
  pattern from `/tmp/kernel-surfaces-smoke.js`). Covers: plugin loads; all 10
  tools register with `output.schema` + `output.render`; `read_file` /
  `write_file` / `edit_file` round-trip on a temp file via a mock `fs`;
  foreground `bash` runs a mocked `subprocess.spawn`; `output.render`
  produces content blocks; `record_note` / `recall_notes` stay session-keyed.
- **Model route is dormant until an API key is present.** End-to-end
  MiniMax-model tool loops require mesh §7.3's key. Until then only the
  surface (apply + registration + mocked execute) can be asserted.

## Future work

- Default `SKILLS_ROOT` to something portable (or empty-with-error) instead of
  a developer machine path; the env override already exists.
- Add on-disk note persistence with a DSH-owned storage location.
- Consider mapping a DSH MCP provider onto Mini-Agent's `mcp__<server>__<tool>`
  naming.

Do **not** add a subagent tool, and do **not** inject unused services (`web`)
as a "forward declaration".

## Layout

```
dsh-kernel-minimax/
  lib/index.js      # the whole plugin (single-file ESM Cordis plugin)
  package.json      # type:module + exports/files/scripts.test (DSH plugin contract)
  LICENSE           # MIT
  README.md         # short human-facing English doc
  README.zh.md      # Chinese translation
  README.i18n.yaml  # bilingual-pair git blob hashes
  AGENTS.md         # this file
  AGENTS.zh-CN.md   # Chinese translation of this file
```
