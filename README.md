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

## Install

Copy the package into your profiles' `node_modules`:

```sh
cp -r dsh-kernel-minimax ~/.dsh/profiles/node_modules/dsh-kernel-minimax
```

Then add this row to the `minimax-kernel` preset's `cordis.yml`:

```yaml
- id: minimax-surface
  name: dsh-kernel-minimax
```

## Usage

Pick the `minimax-kernel` preset and the `minimax-kernel / MiniMax-M2.7` model route. Your main agent runs on the Mini-Agent tool surface.

## License

MIT — see [LICENSE](LICENSE).
