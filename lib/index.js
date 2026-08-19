// dsh-kernel-minimax — "Mini-Agent tool surface written in DSH form": the
// MiniMax Mini-Agent (MiniMax-AI/Mini-Agent) tool surface registered as DSH
// tools with the SAME names, schemas and semantics, implemented directly on
// DSH services (fs/subprocess/jobs). Schemas distilled from
// mini_agent/tools/*.py (Tool subclasses + parameters JSON Schema).
//
// Registered tools:
//   read_file, write_file, edit_file          (file_tools.py)
//   bash, bash_output, bash_kill              (bash_tool.py)
//   get_skill, list_skills                    (skill_tool.py + skill_loader.py)
//   record_note, recall_notes                 (note_tool.py)
//
// MCP tools are load-time dynamic (names come from each MCP server's tool
// list in mcp_loader.py) and are therefore NOT wired in DSH form here.
// Mini-Agent has no subagent tool; this surface deliberately does not invent one.
import { SYSTEM_PROMPT } from './system-prompt.js'

function globFragment(p) {
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += 1; if (p[i + 1] === '/') i += 1 } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end > i) {
        const opts = p.slice(i + 1, end).split(',').map((o) => globFragment(o))
        re += '(' + opts.join('|') + ')'
        i = end
      } else re += '\\{'
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

function globToRegex(pattern) {
  const p = String(pattern).replace(/\\/g, '/')
  try { return new RegExp('^' + globFragment(p) + '$') } catch { return null }
}

const name = 'dsh-kernel-minimax'
const inject = ['fs', 'tools', 'subprocess', 'jobs']

async function apply(ctx, config = {}) {
    const fs = ctx.get('fs')
    const tools = ctx.get('tools')
    const subprocess = ctx.get('subprocess')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const jobs = ctx.get('jobs')
    if (!tools || !fs) return

    // When mounted as a subagent surface, only register the tools the
    // subagent type is allowed to use (config.tools whitelist).
    const register = (t) => {
      if (config.tools && !config.tools.includes(t.name)) return
      tools.register(t)
    }

    // The kernel's own system prompt, shadowing the deployment persona.
    // `complete: true` makes it the SOLE system-prompt section and
    // `suppressRuntimeContext()` drops the runtime-context snapshot, so a
    // session on this kernel sees ONLY the upstream Mini-Agent prompt.
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      if (!(config && config.skipPersona)) {
        systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          text: (config && config.persona) || SYSTEM_PROMPT,
          complete: true,
        })
        if (typeof systemPrompt.suppressRuntimeContext === 'function') systemPrompt.suppressRuntimeContext()
      }
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', '.venv', '__pycache__', 'dist'])
    const policyFor = (exec) => {
      try {
        if (sandboxPolicy && typeof sandboxPolicy.resolve === 'function') {
          return sandboxPolicy.resolve(exec && exec.agent && exec.agent.session ? { session: exec.agent.session } : {})
        }
      } catch {}
      return undefined
    }
    const cwdOf = (exec) => {
      const policy = policyFor(exec)
      if (policy && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
      try { if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string') return sandboxPolicy.workspaceRoot } catch {}
      try { return process.cwd() } catch {}
      return 'C:\\'
    }
    const strDef = (t) => {
      t.output = { schema: { type: 'string' }, render: (a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] }
      return t
    }

    // Location of the Mini-Agent skills tree. Every SKILL.md hangs off here.
    // Overridable via env for hosts that keep the clone elsewhere.
    const SKILLS_ROOT = process.env.DSH_MINIMAX_SKILLS_ROOT || ''

    // Shared recursive walker over fs.listDir, returning {rel, target} pairs.
    // listDir already returns resolved child targets, so recursion uses e.target.
    // One unreadable directory is skipped rather than aborting the whole walk.
    // `keep` optionally filters which files are collected (so the max cap is
    // spent on files that matter, not filler).
    async function walk(dirTarget, rel, out, max, signal, keep, depth, seen) {
      if (out.length >= max || (depth || 0) > 64) return
      const visited = seen || new Set()
      let entries
      try { entries = await fs.listDir(dirTarget, signal) } catch { return }
      for (const e of entries || []) {
        if (out.length >= max) return
        const name = e.name
        if (SKIP_DIRS.has(name)) continue
        const isDir = e.type === 'directory'
        const childRel = rel ? rel + '/' + name : name
        if (isDir) {
          const key = e.target && e.target.targetKey ? e.target.targetKey : childRel
          if (visited.has(key)) continue
          visited.add(key)
          try { await walk(e.target, childRel, out, max, signal, keep, (depth || 0) + 1, visited) } catch {}
        } else if (!keep || keep(childRel)) {
          out.push({ rel: childRel, target: e.target })
        }
      }
    }

    // Extract the `name` and `description` fields from a SKILL.md frontmatter
    // block, mirroring skill_loader.load_skill's required-field contract.
    function parseFrontmatter(text) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
      if (!m) return null
      const name = /^name:\s*(.+?)\s*$/m.exec(m[1])
      const description = /^description:\s*(.+?)\s*$/m.exec(m[1])
      if (!name || !description) return null
      return { name: name[1].replace(/^['"]|['"]$/g, '').trim(), description: description[1].replace(/^['"]|['"]$/g, '').trim() }
    }

    // ---- read_file (file_tools.py, ReadTool) ----
    register(strDef({
      name: 'read_file',
      description: 'Read file contents from the filesystem. Output always includes line numbers in format \'LINE_NUMBER|LINE_CONTENT\' (1-indexed). Supports reading partial content by specifying line offset and limit for large files. You can call this tool multiple times in parallel to read different files simultaneously.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          offset: { type: 'integer', description: 'Starting line number (1-indexed). Use for large files to read from specific line' },
          limit: { type: 'integer', description: 'Number of lines to read. Use with offset for large files to read in chunks' },
        },
        required: ['path'],
      },
      execute: async (args, exec) => {
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        const raw = await fs.readText(target, exec.signal)
        let lines = raw.split(/\r?\n/)
        // readlines()/rstrip semantics: no phantom last line for trailing newline.
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const start = Math.max(0, (args.offset ?? 1) - 1)
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : null
        const end = limit ? Math.min(lines.length, start + limit) : lines.length
        const selected = lines.slice(start, end)
        const numbered = selected.map((line, i) => String(start + i + 1).padStart(6, ' ') + '|' + line)
        return numbered.join('\n')
      },
    }))

    // ---- write_file (file_tools.py, WriteTool) ----
    register(strDef({
      name: 'write_file',
      description: 'Write content to a file. Will overwrite existing files completely. For existing files, you should read the file first using read_file. Prefer editing existing files over creating new ones unless explicitly needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          content: { type: 'string', description: 'Complete content to write (will replace existing content)' },
        },
        required: ['path', 'content'],
      },
      execute: async (args, exec) => {
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        await fs.writeText(target, args.content, undefined, exec.signal, policyFor(exec))
        return 'Successfully wrote to ' + args.path
      },
    }))

    // ---- edit_file (file_tools.py, EditTool) ----
    register(strDef({
      name: 'edit_file',
      description: 'Perform exact string replacement in a file. The old_str must match exactly and appear uniquely in the file, otherwise the operation will fail. You must read the file first before editing. Preserve exact indentation from the source.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          old_str: { type: 'string', description: 'Exact string to find and replace (must be unique in file)' },
          new_str: { type: 'string', description: 'Replacement string (use for refactoring, renaming, etc.)' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
      execute: async (args, exec) => {
        const target = await fs.resolve(args.path, { cwd: cwdOf(exec), signal: exec.signal })
        await fs.editText(target, { oldString: args.old_str, newString: args.new_str, replaceAll: false }, undefined, exec.signal, policyFor(exec))
        return 'Successfully edited ' + args.path
      },
    }))

    // ---- bash (bash_tool.py, BashTool) via subprocess + jobs ----
    register(strDef({
      name: 'bash',
      description: 'Execute PowerShell commands in foreground or background.\n\nFor terminal operations like git, npm, docker, etc. DO NOT use for file operations - use specialized tools.\n\nParameters:\n  - command (required): PowerShell command to execute\n  - timeout (optional): Timeout in seconds (default: 120, max: 600) for foreground commands\n  - run_in_background (optional): Set true for long-running commands (servers, etc.)\n\nTips:\n  - Quote file paths with spaces: cd "My Documents"\n  - Chain dependent commands with semicolon: git add . ; git commit -m "msg"\n  - Use absolute paths instead of cd when possible\n  - For background commands, monitor with bash_output and terminate with bash_kill\n\nExamples:\n  - git status\n  - npm test\n  - python -m http.server 8080 (with run_in_background=true)',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The PowerShell command to execute. Quote file paths with spaces using double quotes.' },
          timeout: { type: 'integer', description: 'Optional: Timeout in seconds (default: 120, max: 600). Only applies to foreground commands.', default: 120 },
          run_in_background: { type: 'boolean', description: 'Optional: Set to true to run the command in the background. Use this for long-running commands like servers. You can monitor output using bash_output tool.', default: false },
        },
        required: ['command'],
      },
      execute: async (args, exec) => {
        if (!subprocess) return 'Error: subprocess service unavailable.'
        let timeout = args.timeout ?? 120
        if (!Number.isFinite(timeout)) timeout = 120
        timeout = Math.min(600, Math.max(1, timeout))
        let pwshBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        try { const r = await subprocess.resolveExecutable('pwsh.exe', undefined, exec.signal); if (r) pwshBin = r } catch {}
        const argv = [pwshBin, '-NoProfile', '-NonInteractive', '-Command', args.command]
        const stdioSpec = { stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 100000 } }
        if (args.run_in_background === true) {
          if (!jobs) return 'Error: jobs service unavailable.'
          if (exec.signal && exec.signal.aborted) return 'Error: aborted before start.'
          // Spawn INSIDE run(): jobs.start preflights first and only then calls
          // run(), so a preflight failure can never leak a live process tree.
          // Background spawns carry no exec.signal: only bash_kill (handle.terminate)
          // may stop them.
          let handle = null
          let cursor = 0
          let errCursor = 0
          let cancelled = false
          const id = jobs.start({
            kind: 'shell',
            label: String(args.command).slice(0, 120) || 'bash',
            owner: exec.agent,
            run: () => {
              handle = subprocess.spawn({ argv, cwd: cwdOf(exec), stdio: stdioSpec, graceMs: 3000 })
              return {
                cancel: (reason) => { cancelled = true; try { handle.terminate() } catch {} },
                done: handle.done.then(
                  (o) => ({ status: cancelled ? 'killed' : (o.exitCode === 0 ? 'completed' : 'failed'), detail: cancelled ? 'stopped by bash_kill' : 'exit ' + o.exitCode }),
                  (e) => ({ status: 'failed', detail: String(e) }),
                ),
                readOutput: () => {
                  if (!handle) return ''
                  const rd = handle.collected.stdout ? handle.collected.stdout.readFrom(cursor) : { text: '', nextOffset: cursor }
                  cursor = rd.nextOffset
                  const er = handle.collected.stderr ? handle.collected.stderr.readFrom(errCursor) : { text: '', nextOffset: errCursor }
                  errCursor = er.nextOffset
                  return rd.text + (er.text ? '\n[stderr]\n' + er.text : '')
                },
              }
            },
          })
          return 'Command started in background. Use bash_output to monitor (bash_id=\'' + id + '\').'
        }
        const handle = subprocess.spawn({ argv, cwd: cwdOf(exec), stdio: stdioSpec, graceMs: 3000, signal: exec.signal })
        const doneSafe = handle.done.then(
          (o) => ({ ok: true, o }),
          (e) => ({ ok: false, e }),
        )
        let timer = null
        let outcome
        try {
          outcome = await Promise.race([
            doneSafe,
            new Promise((resolve) => {
              timer = setTimeout(() => {
                try { handle.terminate() } catch {}
                resolve(null)
              }, timeout * 1000)
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
        if (outcome === null) {
          // Terminate escalates asynchronously (grace → force); wait briefly (or
          // until the turn aborts) so collected output is complete. This 4s wait
          // is teardown, not a hidden command-timeout cap — the documented
          // foreground budget remains timeout seconds (default 120, max 600).
          const grace = new Promise((resolve) => {
            const t = setTimeout(resolve, 4000)
            if (exec.signal) exec.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
          })
          await Promise.race([handle.done.catch(() => {}), grace])
        }
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        const body = (out + (err ? '\n[stderr]:\n' + err : '')).trim()
        if (outcome === null) {
          return body + '\n[timed out after ' + timeout + 's]'
        }
        if (exec.signal && exec.signal.aborted) {
          return body + '\n[aborted]'
        }
        if (!outcome.ok) {
          return body + '\n[spawn failed: ' + String(outcome.e) + ']'
        }
        const code = outcome.o.exitCode === null || outcome.o.exitCode === undefined ? 'unknown' : outcome.o.exitCode
        return body + '\n[exit_code]:\n' + code
      },
    }))

    // ---- bash_output (bash_tool.py, BashOutputTool) via jobs ----
    register(strDef({
      name: 'bash_output',
      description: 'Retrieves output from a running or completed background bash shell.\n\n- Takes a bash_id parameter identifying the shell\n- Always returns only new output since the last check\n- Supports optional regex filtering to show only lines matching a pattern\n- Use this tool when you need to monitor or check the output of a long-running shell\n- Shell IDs can be found using the bash tool with run_in_background=true\n\nExample: bash_output(bash_id="abc12345")',
      parameters: {
        type: 'object',
        properties: {
          bash_id: { type: 'string', description: 'The ID of the background shell to retrieve output from. Shell IDs are returned when starting a command with run_in_background=true.' },
          filter_str: { type: 'string', description: 'Optional regular expression to filter the output lines. Only lines matching this regex will be included in the result.' },
        },
        required: ['bash_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return 'Error: jobs service unavailable.'
        try {
          const read = await jobs.read(args.bash_id, exec.agent)
          let text = read.text || ''
          if (args.filter_str) {
            let re
            try { re = new RegExp(args.filter_str) } catch { re = null }
            if (re) text = text.split(/\r?\n/).filter((line) => re.test(line)).join('\n')
          }
          return text || '[' + (read.snapshot ? read.snapshot.status : 'unknown') + ']'
        } catch (e) {
          // Distinguish a genuinely absent shell from other failures.
          let known = false
          try { known = (jobs.list(exec.agent) || []).some((j) => j.id === args.bash_id) } catch {}
          if (!known) return 'Shell not found: ' + args.bash_id
          return 'bash_output error: ' + String(e)
        }
      },
    }))

    // ---- bash_kill (bash_tool.py, BashKillTool) via jobs ----
    register(strDef({
      name: 'bash_kill',
      description: 'Kills a running background bash shell by its ID.\n\n- Takes a bash_id parameter identifying the shell to kill\n- Attempts graceful termination first, then forces if needed\n- Cleans up all resources associated with the shell\n- Use this tool when you need to terminate a long-running shell\n- Shell IDs can be found using the bash tool with run_in_background=true\n\nExample: bash_kill(bash_id="abc12345")',
      parameters: {
        type: 'object',
        properties: {
          bash_id: { type: 'string', description: 'The ID of the background shell to terminate. Shell IDs are returned when starting a command with run_in_background=true.' },
        },
        required: ['bash_id'],
      },
      execute: async (args, exec) => {
        if (!jobs) return 'Error: jobs service unavailable.'
        try {
          const outcome = jobs.kill(args.bash_id, exec.agent, 'Terminated by bash_kill')
          return 'Terminated ' + args.bash_id + ': ' + outcome
        } catch (e) {
          let known = false
          try { known = (jobs.list(exec.agent) || []).some((j) => j.id === args.bash_id) } catch {}
          if (!known) return 'Shell not found: ' + args.bash_id
          return 'bash_kill error: ' + String(e)
        }
      },
    }))

    // ---- get_skill / list_skills via fs scan of the Mini-Agent skills tree ----
    // Skill scanning: discover every SKILL.md recursively, parse frontmatter.
    async function discoverSkills(signal) {
      const out = []
      let rootTarget
      try { rootTarget = await fs.resolve(SKILLS_ROOT, { signal }) } catch { return null }
      let rootInfo
      try { rootInfo = await fs.stat(rootTarget, signal) } catch { rootInfo = null }
      if (!rootInfo) return null
      const files = []
      // Collect only SKILL.md files so the walk cap is spent on what matters.
      await walk(rootTarget, '', files, 1000, signal, (rel) => /(^|\/)SKILL\.md$/.test(rel))
      for (const item of files) {
        const rel = item.rel
        try {
          const text = await fs.readText(item.target, signal)
          const meta = parseFrontmatter(text)
          if (meta) out.push({ rel, target: item.target, name: meta.name, description: meta.description })
        } catch {}
      }
      return out
    }

    register(strDef({
      name: 'list_skills',
      description: 'List all available skills with their names and descriptions. Skills are specialized guidance bundles discovered from SKILL.md files. Use this before get_skill to discover what is available.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (args, exec) => {
        try {
          const skills = await discoverSkills(exec.signal)
          if (skills === null) return '(skills root not found: ' + SKILLS_ROOT + '; set DSH_MINIMAX_SKILLS_ROOT to the mini-agent skills directory)'
          if (skills.length === 0) return '(no skills discovered)'
          return skills.map((s) => '- `' + s.name + '`: ' + s.description).join('\n')
        } catch (e) {
          return 'list_skills error: ' + String(e)
        }
      },
    }))

    register(strDef({
      name: 'get_skill',
      description: 'Get complete content and guidance for a specified skill, used for executing specific types of tasks',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Name of the skill to retrieve (use list_skills to view available skills)' },
        },
        required: ['skill_name'],
      },
      execute: async (args, exec) => {
        try {
          const skills = await discoverSkills(exec.signal)
          if (skills === null) return 'get_skill error: skills root not found (' + SKILLS_ROOT + '); set DSH_MINIMAX_SKILLS_ROOT to the mini-agent skills directory.'
          const skill = skills.find((s) => s.name === args.skill_name)
          if (!skill) {
            const available = skills.map((s) => s.name).join(', ')
            return "Skill '" + args.skill_name + "' does not exist. Available skills: " + (available || 'none')
          }
          const target = skill.target || await fs.resolve(skill.rel, { cwd: SKILLS_ROOT, signal: exec.signal })
          const raw = await fs.readText(target, exec.signal)
          const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
          // The skill root is the directory CONTAINING this SKILL.md, not the
          // whole skills tree (upstream Skill.to_prompt uses skill_path.parent).
          const relDir = skill.rel.split('/').slice(0, -1).join('/')
          const skillDir = relDir ? SKILLS_ROOT + '\\' + relDir.split('/').join('\\') : SKILLS_ROOT
          return '# Skill: ' + skill.name + '\n\n' + skill.description + '\n\n**Skill Root Directory:** `' + skillDir + '`\n\nAll files and references in this skill are relative to this directory.\n\n---\n\n' + body
        } catch (e) {
          return 'get_skill error: ' + String(e)
        }
      },
    }))

    // ---- record_note (note_tool.py, SessionNoteTool) with a per-session store ----
    const noteStore = new Map() // keyed by session id so concurrent sessions never share notes
    const notesFor = (exec) => {
      const key = exec.agent && exec.agent.session && exec.agent.session.id != null ? String(exec.agent.session.id) : 'default'
      if (!noteStore.has(key)) noteStore.set(key, [])
      return noteStore.get(key)
    }
    register(strDef({
      name: 'record_note',
      description: 'Record important information as session notes for future reference. Use this to record key facts, user preferences, decisions, or context that should be recalled later in the agent execution chain. Each note is timestamped.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The information to record as a note. Be concise but specific.' },
          category: { type: 'string', description: "Optional category/tag for this note (e.g., 'user_preference', 'project_info', 'decision')", default: 'general' },
        },
        required: ['content'],
      },
      execute: async (args, exec) => {
        const note = {
          timestamp: new Date().toISOString(),
          category: args.category || 'general',
          content: args.content,
        }
        notesFor(exec).push(note)
        return 'Recorded note: ' + args.content + ' (category: ' + (args.category || 'general') + ')'
      },
    }))

    // ---- recall_notes (note_tool.py, RecallNoteTool) ----
    register(strDef({
      name: 'recall_notes',
      description: 'Recall all previously recorded session notes. Use this to retrieve important information, context, or decisions from earlier in the session or previous agent execution chains.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional: filter notes by category' },
        },
      },
      execute: async (args, exec) => {
        let notes = notesFor(exec)
        if (args.category) notes = notes.filter((n) => n.category === args.category)
        if (notes.length === 0) {
          return args.category ? 'No notes found in category: ' + args.category : 'No notes recorded yet.'
        }
        const formatted = notes.map((note, idx) => String(idx + 1) + '. [' + (note.category || 'general') + '] ' + note.content + '\n   (recorded at ' + (note.timestamp || 'unknown time') + ')')
        return 'Recorded Notes:\n' + formatted.join('\n')
      },
    }))
}

export { name, inject, apply }
