# Changelog

## 1.0.3

- **Upstream system prompt.** `lib/system-prompt.js` carries the Mini-Agent
  `system_prompt.md` (skill metadata adapted to DSH); `apply()` registers it as
  `deployment:persona` with `complete: true` + `suppressRuntimeContext()`.
- **Subagent mounting config.** `apply(ctx, config)` accepts `config.persona`,
  `config.skipPersona`, and `config.tools`. Mini-Agent has no subagent tool
  upstream, so this package ships no L2 recipes.

## 0.1.2

- Initial DSH-form Mini-Agent tool surface.
