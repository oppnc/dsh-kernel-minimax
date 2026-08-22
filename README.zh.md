[English](README.md) | 中文

# dsh-kernel-minimax

DSH 有个很朴素的想法：**一切都是插件**。模型是插件，工具是插件，子代理也是插件，想怎么拼就怎么拼。

顺着这个思路，我们把 MiniMax 的 **Mini-Agent 写成了 DSH 插件**。你熟悉的 mini-agent 工具面——`read_file`、`write_file`、`edit_file`、`bash`、`bash_output`、`bash_kill`、`get_skill`、`list_skills`、`record_note`、`recall_notes`——现在就是 DSH 的原生工具，名字一样、参数一样、行为一样。

好处很简单：在 DSH 里原生使用 Mini-Agent 这套工具，和直接打开 Mini-Agent **没有任何区别**。每个模型都待在自己最熟悉的环境里，不管是主 agent 还是 subagent，感觉就像回家一样。

对齐 MiniMax-AI/Mini-Agent `d76a4f6`（2026-02-14）。此后没有新的模型可见工具。

> `minimax-kernel` 模型路由需要 API key，放在 `~/.mini-agent/config.yaml`：

```yaml
api_key: "sk-..."
```

## 系统提示词

`lib/system-prompt.js` 携带上游 **Mini-Agent** 的 `system_prompt.md`（技能元数据
已适配 DSH）；`apply()` 把它注册为 agent 唯一的 system-prompt 段（`complete: true`
+ `suppressRuntimeContext()`）。

Mini-Agent 上游没有子代理工具，所以本包不提供 L2 子代理配方。

## 安装

1. 用官方插件命令把本包装进你的 profile：

   ```sh
   dsh plugin --profile web add github:oppnc/dsh-kernel-minimax
   ```

   本包是普通插件（没有 `dsh.bundle` 声明），`dsh plugin` 会把它作为不激活的依赖安装——这是预期行为：下面的预设行会按名字引用它。

2. 安装 `minimax-kernel` agent 预设：把它的目录复制到 `~/.dsh/.agent-presets/minimax-kernel/`。随附的预设已经包含 `minimax-surface` 行；如果你自己写预设，就加上这一行：

   ```yaml
   - id: minimax-surface
     name: dsh-kernel-minimax
   ```

## 使用

选 `minimax-kernel` 预设和 `minimax-kernel / MiniMax-M2.5` 模型路由，主 agent 就跑在 Mini-Agent 的工具面上。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
