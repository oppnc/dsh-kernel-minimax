# Changelog

## 0.1.7

- **Publish channels.** Preferred install is `dsh plugin --profile web add dsh-kernel-minimax` (npm, once published); GitHub remains a fallback because `lib/` ships in the repository. The mesh dependency is `github:oppnc/dsh-kernel-mesh#semver:^0.1.7`. Keywords include `dsh-plugin`.

## 0.1.6

- **Mesh dependency + fallback mount.** `dsh-kernel-mesh` is now a declared
  dependency (`dsh-kernel-mesh@^0.1.6`, originally a GitHub specifier), so installing this
  package also installs the mesh. At `apply()` time the plugin checks for the
  mesh's `kernelMesh` marker service / any `*-kernel` route; when the host
  composition never mounted the mesh, the plugin mounts its own copy
  (`lib/ensure-mesh.js`) so kernel routes and subagent recipes keep working —
  with a logged pointer to the preferred profile-level mount
  (`dsh plugin add dsh-kernel-mesh`), since a fallback-mounted mesh shares this
  row's lifecycle.

## 0.1.4

- **`SKILLS_ROOT` no longer defaults to a developer-machine path.** It must be
  set via `DSH_MINIMAX_SKILLS_ROOT`; when unset, `get_skill`/`list_skills`
  return a clear error.
- **README model route** updated to `MiniMax-M2.5` (Mini-Agent's default model).

## 0.1.3

- **Upstream system prompt.** `lib/system-prompt.js` carries the Mini-Agent
  `system_prompt.md` (skill metadata adapted to DSH); `apply()` registers it as
  `deployment:persona` with `complete: true` + `suppressRuntimeContext()`.
- **Subagent mounting config.** `apply(ctx, config)` accepts `config.persona`,
  `config.skipPersona`, and `config.tools`. Mini-Agent has no subagent tool
  upstream, so this package ships no L2 recipes.

## 0.1.2

- Initial DSH-form Mini-Agent tool surface.
