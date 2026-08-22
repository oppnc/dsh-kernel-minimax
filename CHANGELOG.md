# Changelog

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
