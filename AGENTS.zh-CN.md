# AGENTS.md — 维护者指南

`dsh-kernel-minimax` 的详细工程说明。本包是"写成 DSH 形式的 Mini-Agent"：将 MiniMax
Mini-Agent（https://github.com/MiniMax-AI/Mini-Agent）工具面以相同名称、相同 schema
重新注册为 DSH 工具，并实现在 DSH 服务之上，从而使该工具面在 `toolFilter` 裁剪下依然存活。

## 本包是什么

运行 `minimax-kernel` 模型路由的 DSH 智能体，看到的工具名、JSON schema 与语义应与原生
Mini-Agent 运行一致——但底层由 DSH 服务（`fs`、`subprocess`、`jobs`）支撑，而非
Mini-Agent 的 Python 运行时。schema 提炼自 `mini_agent/tools/*.py`，其中每个工具都是一个
携带 `parameters` JSON Schema 的 `Tool` 子类。

插件是一个 Cordis 插件对象：

```js
export const name = 'dsh-kernel-minimax'
export const inject = ['fs', 'tools', 'subprocess', 'jobs']
export async function apply(ctx) { /* 注册全部工具 */ }
```

`inject` 是 Cordis 的**硬依赖屏障**（mesh AGENTS.md §2）：Cordis 会等到每个声明的服务就绪后
才调用 `apply()`。只有插件无法启动时缺少的服务——`fs`、`tools`、`subprocess`、`jobs`——
才应列入。可选服务（`sandboxPolicy`）通过 `ctx.get(...)` 读取并对 `undefined` 做防护。
切勿把未在 `inject` 中声明的服务当作裸的 `ctx.<name>` 属性读取。若 `tools` 或 `fs` 缺失，
插件会提前返回、不注册任何内容。`subprocess` / `jobs` 仍作为硬注入以便启动时等待它们，
但 `execute` 会再次检查 `ctx.get(...)`，若运行中被拆除则降级为工具内错误字符串。

所有注册（`tools.register`）以及内存中的 `noteStore` 都活在 `apply()` 内，并绑定到插件
fiber。没有模块级副作用。停止或更新该行会释放全部工具与笔记 Map。

## 工具清单与 schema 来源

| 工具 | 上游来源 | 来源说明 |
| --- | --- | --- |
| `read_file` | `mini_agent/tools/file_tools.py` — `ReadTool` | `path`（必填）、`offset`、`limit`。输出为带行号的 `LINE_NUMBER\|LINE_CONTENT`，从 1 计数，与 Mini-Agent 格式一致。 |
| `write_file` | `mini_agent/tools/file_tools.py` — `WriteTool` | `path`、`content` 均必填。完全覆盖写入语义。 |
| `edit_file` | `mini_agent/tools/file_tools.py` — `EditTool` | `path`、`old_str`、`new_str`，保留精确匹配、必须唯一的规则。 |
| `bash` | `mini_agent/tools/bash_tool.py` — `BashTool` | `command`（必填）、`timeout`（默认 120 秒，最大 600 秒，仅前台）、`run_in_background`。 |
| `bash_output` | `mini_agent/tools/bash_tool.py` — `BashOutputTool` | `bash_id`（必填）、`filter_str`（正则）。仅返回上次读取之后的新增输出。 |
| `bash_kill` | `mini_agent/tools/bash_tool.py` — `BashKillTool` | `bash_id`（必填）。经 `jobs.kill` 先优雅终止、再强制。 |
| `get_skill` | `mini_agent/tools/skill_tool.py`（+ `skill_loader.py`） | `skill_name`（必填）。返回完整 SKILL.md 正文。 |
| `list_skills` | `skill_loader.py`（推断而来——见"如实标注"） | 无参数。列出技能的 `name` + `description`。 |
| `record_note` | `mini_agent/tools/note_tool.py` — `SessionNoteTool` | `content`（必填）、`category`。带时间戳的会话笔记。 |
| `recall_notes` | `mini_agent/tools/note_tool.py` — `RecallNoteTool` | `category`（可选过滤）。返回所有已记录笔记。 |

**没有** subagent / Agent / task 工具。Mini-Agent 原生工具面本身就没有，本包不得发明一个。
mesh L2 仍可通过 `dsh-kernel-mesh` 的 `kernel_run` 暴露 `minimax-agent` 配方；那是 mesh
的事，不是 Mini-Agent 工具面上的工具。

## 如实标注（近似与省略）

维护者**不能**盲目"修复"以下这些点——每一条都是有意的、已记录的对上游的偏离。

1. **`list_skills` 是作为工具推断出来的。** 上游 Mini-Agent 并不暴露独立的
   `list_skills` 工具。相反，skill loader 会把技能名称 + 描述列表作为元数据直接注入
   系统提示（`skill_loader.py` 构造了那段提示块）。DSH 没有被我们可靠依赖的"从插件向
   系统提示注入"钩子，因此 `list_skills` 被注册为一个真正的、按需扫描技能树的工具。
   它在功能上等价，但它是原生工具面的一个*新增*，而非镜像。

2. **`recall_notes` 已定义但上游未接线。** Mini-Agent 的 `RecallNoteTool` 存在于
   `note_tool.py` 中，但并未真正注册进上游智能体的工具列表。我们仍然注册它，使笔记面
   完整且自洽（只有 `record_note` 而没有 recall 毫无意义）。

3. **MCP 工具有意省略。** Mini-Agent 在加载时*动态*命名 MCP 工具：`mcp_loader.py` 会枚举
   每个已配置 MCP 服务器的工具列表，并以这些服务器派生的名称注册工具。没有固定 schema
   可供镜像，因此以 DSH 形式接线超出了本包范围。若未来出现 DSH 侧 MCP provider，可按
   相同的 `mcp__<server>__<tool>` 命名约定进行映射。

4. **`globToRegex` 被保留但当前未使用。** 某些版本的 Mini-Agent `EditTool` 支持 glob 模式
   匹配；我们保留了该辅助函数，但 `edit_file` 使用精确匹配（唯一）语义，与提炼出的
   schema 一致。

5. **没有子代理工具。** Mini-Agent 没有委派原语。即使 mesh 缺口 #5（可续接子代理）已在
   `dsh-kernel-mesh` 解决，也不要在此添加 `subagent` / `Agent` / `task`。若 MiniMax 会话
   需要子代理，走 mesh 的 `kernel_run` / 原生 `subagent` 路径——不要走本工具面。

## 实现决策

- **文件系统是 `fs` + 策略透传。** `read_file`/`write_file`/`edit_file` 以沙箱工作区根
  （`sandboxPolicy.workspaceRoot`）为基准解析路径，并把 `sandboxPolicy.resolve()` 作为
  第 5 个参数传给 `fs.writeText`/`fs.editText`，从而遵守当前会话的文件策略。没有这层
  透传，写入会被沙箱拒绝。`read_file` 仅针对文本（`fs.readText`），在去掉末尾空 split
  （Python `readlines()`/`rstrip` 语义）后按 `LINE_NUMBER|LINE_CONTENT` 编号。

- **`bash` 是 `subprocess` + `jobs`，而非真正的 shell 名称。** DSH 没有 `bash` 服务；等价物
  是 `subprocess.spawn` 配合内置的 `jobs` 注册表来管理后台句柄。`bash` 映射到一次
  **PowerShell** 调用（本系列插件的历史 Windows 宿主假设），而非 POSIX bash。我们通过
  `subprocess.resolveExecutable` 解析 `pwsh.exe`，失败时回退到绝对路径
  `powershell.exe`（`C:\Windows\System32\...`）——这是历史 bug：净化后的 PATH 使裸名称
  触发 ENOENT。在 Linux/WSL 宿主上，该回退是有记录的宿主形态遗留；真正查找走
  `resolveExecutable('pwsh.exe')`。

  前台超时是**诚实的**：默认 120 秒，钳位到 `[1, 600]` 秒，与工具描述一致。没有低于
  600 秒的隐藏墙钟上限。超时后调用 `handle.terminate()`，并最多再等 4 秒（或直到
  `exec.signal` 中止）以收齐已采集输出——这 4 秒是拆除等待，不是第二份命令预算。
  后台任务**不携带** `exec.signal`；只有 `bash_kill`（`jobs.kill` → `handle.terminate`）
  可以停止它们。spawn 发生在 `jobs.start({ run })` **内部**，因此预检失败不会泄漏活的
  进程树。`bash_output` 使用 jobs 的消费游标（`jobs.read`）；`filter_str` 作用于增量。

- **技能从 Mini-Agent 的 `skills/` 树扫描。** `SKILLS_ROOT` 默认指向一个历史绝对
  Windows 路径，可用 `DSH_MINIMAX_SKILLS_ROOT` 覆盖。`discoverSkills()` 递归遍历该树
  （跳过 `node_modules`、`.git`、`.dsh`、`.venv`、`__pycache__`、`dist`），找出每个
  `SKILL.md`，解析 `name`/`description` YAML frontmatter——与
  `skill_loader.load_skill` 的必填字段契约一致（没有 name 或没有 description 的技能
  会被跳过）。`get_skill` 随后剥离 frontmatter，并把技能根报告为*包含*该 `SKILL.md`
  的目录。硬编码默认值仍是最大的可移植性隐患；环境变量是受支持的覆盖方式。

- **笔记存放在插件本地内存存储中。** `record_note`/`recall_notes` 把内容压入在
  `apply()` 内创建、以 `exec.agent.session.id` 为键的 `noteStore` `Map`，因此并发会话
  不会共享笔记。上游 Mini-Agent 会把笔记持久化到它自己的会话目录；我们刻意把笔记放在
  内存中，因为 DSH 会话拥有自身生命周期，而本包尚未定义稳定的磁盘笔记位置。跨会话
  持久化是候选的后续工作。

## DSH `ToolDefinition` 合约

每个工具通过 `tools.register(t)` 注册，其中 `t` 满足 DSH 的 `ToolDefinition` 结构
（mesh AGENTS.md §3.4）：

- `name` — 模型所见工具名。
- `description` — 自由文本指导（从上游 docstring 复制/改写）。
- `parameters` — 描述参数的 JSON Schema 对象。
- `output` — `{ schema, render }` **二者都必需**。`output.schema` 是*受强制约束的子集*：
  只有声明的字段会到达模型/UI。这里每个工具都走 `strDef`，它设置
  `output.schema = { type: 'string' }` 并附带文本
  `render(a, v) => [{ type: 'text', text }]`。把缺失的 `render` 当作 bug，不要指望
  mesh 的兜底来掩盖。
- `execute(args, exec)` — 异步处理器；`exec.signal` 用于取消，`exec.agent` 作为后台
  任务的 `owner`。

## 已知缺口

- **没有 Mini-Agent 子代理工具。** 有意缺席（如实标注 5）。mesh 缺口 #5 已在 *mesh*
  解决；本工具面不消费该路由。
- **MCP / 动态工具被省略** —— 没有可供镜像的固定 schema。
- **技能默认路径与宿主绑定。** 用 `DSH_MINIMAX_SKILLS_ROOT` 覆盖。
- **笔记仅存活于进程生命周期。** fiber 作用域的 `Map`，不落盘。
- **`bash` 呈 PowerShell 形态。** 命令字符串以 `-Command` 交给 `pwsh`/`powershell`，
  不是 `/bin/bash -lc`。

### 本工具面继承的 mesh 缺口（当前事实）

这些记录在 `dsh-kernel-mesh` AGENTS.md §7，**不是**本包的待办（除非另行注明）：

- **§7.1 Kimi thinking signature 侧表** —— 仅 Kimi；此处不用。
- **§7.2 Grok reasoning 重放** —— Grok/Responses-wire；此处不用。
- **§7.3 MiniMax 需要 API key。** 只有 `~/.mini-agent/config.yaml`（回退
  `~/.config/mini-agent/config.yaml`）里存在 `api_key`（`sk-...`）时，
  `minimax-kernel` 才会注册。无 key → 无 L1 路由，`kernel_switch('minimax')` 要到
  解析时才会报告 unknown/unavailable。本工具面在没有 key 时仍会挂载并注册全部十个
  工具；休眠的只是*模型路由*。这是本插件内核的 mesh 侧门闩。
- **§7.4 `loop_control` 没有 DSH 旋钮。** 源自 Kimi；Mini-Agent 无对应物。在 harness
  暴露该旋钮之前，对齐仅停留在文档层面。
- ~~**§7 #5 可续接子代理。**~~ **已在 mesh 解决**（`subagents.startContinuable`）。
  本工具面没有子代理工具，因此不调用该路由。
- ~~**§7 #6 非流式传输。**~~ **已在 mesh 解决**：两条 adapter 工厂现在真正流式传输
  SSE（`stream: true`、curl `-N`），并在提供方忽略流式时自动回退到 JSON。本工具面
  自身没有传输层。
- ~~**未分类的 adapter 错误。**~~ **已在 mesh 解决**：adapter 以规范的自有属性码
  （`e.code` + `e.failure`）抛出，因此 `dsh-llm-retry` 会重试 `RATE_LIMIT` /
  `SERVER` / `TIMEOUT` / `TRANSPORT`。本工具面不抛出 adapter 错误。
- **§7.7 Responses 线图片仍被上游挡住。** MiniMax 本身是 Anthropic 线，mesh 适配器
  *会*解析 DSH `image` 块。本工具面仍无图片工具（Mini-Agent 也没有）。

## 测试说明

- **语法：** 每次改动后跑 `node --check lib/index.js`；该文件是纯 ESM（`type: module`）、无构建步骤。
- **surface 冒烟：** `/tmp/kernel-surfaces-smoke-minimax.js`（沿用
  `/tmp/kernel-surfaces-smoke.js` 的 mock-ctx 模式）。覆盖：插件加载；全部 10 个工具
  带着 `output.schema` + `output.render` 注册；经 mock `fs` 对临时文件做
  `read_file` / `write_file` / `edit_file` 往返；前台 `bash` 跑一次 mock 的
  `subprocess.spawn`；`output.render` 产出 content block；`record_note` /
  `recall_notes` 按会话分键。
- **模型路由在存在 API key 之前处于休眠状态。** 端到端 MiniMax 模型工具循环需要
  mesh §7.3 的 key。在此之前只能断言 surface（apply + 注册 + mock 执行）。

## 后续工作

- 把默认 `SKILLS_ROOT` 改成可移植路径（或空并报错），而不是开发者机器路径；环境变量
  覆盖已经存在。
- 增加带 DSH 自主存储位置的磁盘笔记持久化。
- 考虑将 DSH MCP provider 映射到 Mini-Agent 的 `mcp__<server>__<tool>` 命名。

**不要**添加子代理工具，也**不要**把未使用的服务（`web`）当作"前向声明"注入。

## 目录结构

```
dsh-kernel-minimax/
  lib/index.js      # 整个插件（单文件 ESM Cordis 插件）
  package.json      # type:module + exports/files/scripts.test（DSH 插件契约）
  LICENSE           # MIT
  README.md         # 面向用户的简短英文文档
  README.zh.md      # 中文翻译
  README.i18n.yaml  # 双语配对的 git blob hash
  AGENTS.md         # 本文件
  AGENTS.zh-CN.md   # 本文件的中文翻译
```
