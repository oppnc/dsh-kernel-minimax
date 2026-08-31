English | [中文](README.zh.md)

# dsh-kernel-minimax

DSH runs on one simple idea: **everything is a plugin**. Models, tools, subagents — plug them together however you like.

So we did exactly that: we turned MiniMax's **Mini-Agent into a DSH plugin**. The mini-agent tool surface you already know — `read_file`, `write_file`, `edit_file`, `bash`, `bash_output`, `bash_kill`, `get_skill`, `list_skills`, `record_note`, `recall_notes` — is now a set of native DSH tools. Same names, same schemas, same behavior.

The payoff is simple: use Mini-Agent's tools natively inside DSH — **no different** from opening Mini-Agent itself. Every model stays in the environment it knows best — main agent or subagent, it feels like coming home.

Distilled from MiniMax-AI/Mini-Agent `d76a4f6` (2026-02-14). No new model-facing tools since then.

> The `minimax-kernel` model route needs a MiniMax API key in `~/.mini-agent/config.yaml`:

```yaml
api_key: "sk-..."
```

## System prompt

`lib/system-prompt.js` carries the upstream **Mini-Agent** `system_prompt.md`
(skill metadata adapted to DSH); `apply()` registers it as the agent's sole
system-prompt section (`complete: true` + `suppressRuntimeContext()`).

Mini-Agent has no subagent tool upstream, so this package ships no L2 subagent
recipes.

## Install

1. Install the plugin into your profile with the official plugin command:

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-minimax
   ```

   Once the package is on npm, `dsh plugin --profile web add dsh-kernel-minimax` is preferred (prebuilt, no `allowBuilds`).

   This package is a plain plugin (no `dsh.bundle` declaration), so `dsh plugin` installs it as an inactive dependency — that is expected: the preset row below references it by name.

2. The `minimax-kernel` agent preset ships in `dsh-kernel-mesh`'s `presets/` directory. Copy it into the official user-preset root (or, if you run without the mesh, get the preset directory from the mesh repo):

     ```sh
     dsh_home="${DSH_HOME:-$HOME/.dsh}"
     cp -r "$dsh_home/profiles/web/node_modules/dsh-kernel-mesh/presets/minimax-kernel" "$dsh_home/.agent-presets/"
     ```

     The preset already includes the `minimax-surface` row; if you author your own preset, add it:

   ```yaml
   - id: minimax-surface
     name: dsh-kernel-minimax
   ```

## Usage

Pick the `minimax-kernel` preset and the `minimax-kernel / MiniMax-M2.5` model route. Your main agent runs on the Mini-Agent tool surface.

## License

MIT — see [LICENSE](LICENSE).
