import assert from 'node:assert/strict'
import path from 'node:path'
import * as pluginMod from '../lib/index.js'

let assertionCount = 0
function ok(value, message) {
  assertionCount += 1
  assert.ok(value, message)
}
function eq(actual, expected, message) {
  assertionCount += 1
  assert.equal(actual, expected, message)
}
function match(actual, re, message) {
  assertionCount += 1
  assert.match(String(actual), re, message)
}

function keyOf(target) {
  if (typeof target === 'string') return path.normalize(target)
  if (target && typeof target.path === 'string') return path.normalize(target.path)
  return String(target)
}

function makeTarget(p) {
  const n = path.normalize(p)
  return { path: n, displayPath: n, targetKey: n }
}

function createHarness() {
  const workspaceRoot = '/workspace'
  const files = new Map()
  const registered = new Map()
  const sections = []
  const calls = {
    startContinuable: [],
    start: [],
    followup: [],
    interrupt: [],
    listChildren: [],
    list: [],
    writeText: [],
    editText: [],
    spawn: [],
    jobsStart: [],
    jobsRead: [],
    jobsKill: [],
  }

  const fs = {
    async resolve(p, opts) {
      const cwd = (opts && opts.cwd) || workspaceRoot
      const raw = String(p)
      if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return makeTarget(raw)
      return makeTarget(path.join(cwd, raw))
    },
    async readText(target) {
      const key = keyOf(target)
      if (!files.has(key)) {
        const err = new Error('FS_NOT_FOUND: ' + key)
        err.code = 'FS_NOT_FOUND'
        throw err
      }
      return files.get(key).text
    },
    async writeText(target, content) {
      const key = keyOf(target)
      const prev = files.get(key)
      files.set(key, { text: String(content), version: (prev ? prev.version : 0) + 1, type: 'file' })
      calls.writeText.push({ path: key, content: String(content) })
    },
    async editText(target, edit) {
      const key = keyOf(target)
      if (!files.has(key)) {
        const err = new Error('FS_NOT_FOUND: ' + key)
        err.code = 'FS_NOT_FOUND'
        throw err
      }
      const cur = files.get(key)
      const oldString = edit.oldString
      const newString = edit.newString
      let next
      if (edit.replaceAll) next = cur.text.split(oldString).join(newString)
      else {
        const idx = cur.text.indexOf(oldString)
        if (idx < 0) throw new Error('oldString not found in ' + key)
        next = cur.text.slice(0, idx) + newString + cur.text.slice(idx + oldString.length)
      }
      files.set(key, { text: next, version: cur.version + 1, type: 'file' })
      calls.editText.push({ path: key, edit })
    },
    async stat(target) {
      const key = keyOf(target)
      if (!files.has(key)) return null
      const rec = files.get(key)
      return { type: rec.type || 'file', size: Buffer.byteLength(rec.text || ''), version: rec.version }
    },
    async listDir(target) {
      const dir = keyOf(target).replace(/[\\/]+$/, '')
      const kids = new Map()
      for (const [p, rec] of files) {
        if (p === dir) continue
        const prefix = dir + path.sep
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const name = rest.split(/[\\/]/)[0]
        if (!name || kids.has(name)) continue
        const childPath = path.join(dir, name)
        const isDir = rest.includes(path.sep) || rec.type === 'directory'
        kids.set(name, {
          name,
          type: isDir ? 'directory' : 'file',
          target: makeTarget(childPath),
        })
      }
      return Array.from(kids.values())
    },
    processPath(target) { return keyOf(target) },
    contains() { return true },
  }

  const tools = {
    register(def) {
      if (!def || !def.name) throw new Error('tool missing name')
      if (registered.has(def.name)) throw new Error('already registered: ' + def.name)
      registered.set(def.name, def)
    },
    get(name) { return registered.get(name) },
  }

  const subagents = {
    list() {
      calls.list.push(true)
      return ['minimax-agent', 'spawn']
    },
    async startContinuable(req) {
      calls.startContinuable.push(req)
      return { childId: 'should-not-happen' }
    },
    async start(provider, request) {
      calls.start.push({ provider, request })
      return { result: Promise.resolve({ stopReason: 'completed', output: [] }), async dispose() {} }
    },
    async followup(agent, childId, blocks, opts) {
      calls.followup.push({ agent, childId, blocks, opts })
      return 'msg'
    },
    interrupt(agentId, info) { calls.interrupt.push({ agentId, info }) },
    async listChildren(parentId, signal) {
      calls.listChildren.push({ parentId, signal })
      return []
    },
  }

  const jobsStore = new Map()
  let jobSeq = 0
  const jobs = {
    start(spec) {
      const id = 'bash-' + (++jobSeq)
      const handle = spec.run()
      jobsStore.set(id, { id, status: 'running', label: spec.label, handle })
      calls.jobsStart.push({ id, spec })
      return id
    },
    list() { return Array.from(jobsStore.values()).map((j) => ({ id: j.id, status: j.status, label: j.label })) },
    async read(id) {
      calls.jobsRead.push(id)
      const j = jobsStore.get(id)
      if (!j) throw new Error('job not found: ' + id)
      const text = j.handle && typeof j.handle.readOutput === 'function' ? j.handle.readOutput() : ''
      return { text, snapshot: { status: j.status, detail: '' } }
    },
    async wait() {},
    kill(id, agent, reason) {
      calls.jobsKill.push({ id, reason })
      const j = jobsStore.get(id)
      if (!j) throw new Error('job not found: ' + id)
      j.status = 'killed'
      if (j.handle && j.handle.cancel) j.handle.cancel(reason)
      return 'killed'
    },
  }

  const subprocess = {
    async resolveExecutable(name) { return '/mock/' + name },
    spawn(opts) {
      calls.spawn.push(opts)
      const stdout = { text: 'minimax-ok\n', readFrom(off) { return { text: this.text.slice(off), nextOffset: this.text.length } } }
      const stderr = { text: '', readFrom(off) { return { text: this.text.slice(off), nextOffset: this.text.length } } }
      return {
        collected: { stdout, stderr },
        done: Promise.resolve({ exitCode: 0 }),
        terminate() {},
      }
    },
  }

  const services = {
    fs,
    tools,
    subprocess,
    jobs,
    sandboxPolicy: {
      workspaceRoot,
      resolve() { return { mode: 'danger-full-access', workspaceRoot } },
    },
    // Present so a leaky plugin that ctx.get's them is observable, but MiniMax
    // must not register a subagent tool even if these exist.
    subagents,
    systemPrompt: { section(s) { sections.push(s) } },
    planMode: { set() { return 'ok' } },
    web: { async search() { return { results: [] } }, async fetch() { return { body: { content: '' } } } },
  }

  return {
    ctx: { get(name) { return services[name] } },
    registered,
    sections,
    calls,
    files,
    workspaceRoot,
    seed(rel, text) {
      const p = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel)
      files.set(path.normalize(p), { text, version: 1, type: 'file' })
      return path.normalize(p)
    },
    readSeed(rel) {
      const p = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel)
      const rec = files.get(path.normalize(p))
      return rec ? rec.text : undefined
    },
  }
}

const EXPECTED_TOOLS = [
  'read_file', 'write_file', 'edit_file',
  'bash', 'bash_output', 'bash_kill',
  'get_skill', 'list_skills',
  'record_note', 'recall_notes',
]

const FORBIDDEN_TOOLS = [
  'Agent', 'task', 'spawn_agent', 'subagent',
  'assign_agent_task', 'send_message', 'followup_task',
  'resume_agent', 'interrupt_agent', 'list_agents',
]

async function main() {
  const plugin = pluginMod
  ok(plugin, 'plugin module loads')
  eq(plugin.name, 'dsh-kernel-minimax', 'plugin.name')
  ok(typeof plugin.apply === 'function', 'plugin.apply is a function')
  ok(Array.isArray(plugin.inject), 'plugin.inject is metadata')

  const h = createHarness()
  await plugin.apply(h.ctx)

  for (const name of EXPECTED_TOOLS) {
    ok(h.registered.has(name), 'registers ' + name)
  }
  eq(h.registered.size, EXPECTED_TOOLS.length, 'expected tool count')

  for (const name of FORBIDDEN_TOOLS) {
    ok(!h.registered.has(name), 'does not register subagent tool ' + name)
  }
  eq(h.calls.startContinuable.length, 0, 'minimax never calls startContinuable during apply')
  eq(h.sections.length, 0, 'minimax does not register a systemPrompt section')

  for (const [name, def] of h.registered) {
    ok(def.output && typeof def.output === 'object', name + ' has output')
    ok(def.output.schema, name + ' has output.schema')
    ok(typeof def.output.render === 'function', name + ' has output.render')
    const rendered = def.output.render({}, 'ok')
    ok(Array.isArray(rendered), name + ' render returns blocks')
  }

  const exec = { agent: { id: 'parent-session', session: { id: 'sess-1' } }, signal: new AbortController().signal }

  const write_file = h.registered.get('write_file')
  const read_file = h.registered.get('read_file')
  const edit_file = h.registered.get('edit_file')

  const w = await write_file.execute({ path: 'notes.txt', content: 'alpha\nbeta\ngamma\n' }, exec)
  match(w, /Successfully wrote/, 'write_file confirmation')
  eq(h.calls.writeText.length, 1, 'write_file used fs.writeText')
  eq(h.readSeed('notes.txt'), 'alpha\nbeta\ngamma\n', 'write_file persisted content')

  const r = await read_file.execute({ path: 'notes.txt' }, exec)
  match(r, /1\|alpha/, 'read_file line 1 numbered LINE_NUMBER|LINE_CONTENT')
  match(r, /2\|beta/, 'read_file line 2 numbered')
  match(r, /3\|gamma/, 'read_file line 3 numbered (trailing newline dropped)')
  ok(!/4\|/.test(r), 'read_file does not emit a phantom 4th line')

  const partial = await read_file.execute({ path: 'notes.txt', offset: 2, limit: 1 }, exec)
  match(partial, /2\|beta/, 'read_file offset/limit selects line 2')
  ok(!/alpha/.test(partial) && !/gamma/.test(partial), 'read_file offset/limit excludes other lines')

  const e = await edit_file.execute({ path: 'notes.txt', old_str: 'beta', new_str: 'BETA' }, exec)
  match(e, /Successfully edited/, 'edit_file confirmation')
  eq(h.calls.editText.length, 1, 'edit_file used fs.editText')
  eq(h.calls.editText[0].edit.oldString, 'beta', 'edit_file maps old_str → oldString')
  eq(h.calls.editText[0].edit.newString, 'BETA', 'edit_file maps new_str → newString')
  eq(h.calls.editText[0].edit.replaceAll, false, 'edit_file is unique-match (replaceAll false)')
  eq(h.readSeed('notes.txt'), 'alpha\nBETA\ngamma\n', 'edit_file updated mock fs')

  const after = await read_file.execute({ path: 'notes.txt' }, exec)
  match(after, /2\|BETA/, 'read_file sees the edit')

  const bash = h.registered.get('bash')
  const fg = await bash.execute({ command: 'echo hi' }, exec)
  eq(h.calls.spawn.length, 1, 'bash foreground uses subprocess.spawn')
  match(fg, /minimax-ok/, 'bash foreground includes stdout')
  match(fg, /\[exit_code\]:\n0/, 'bash foreground reports exit_code')
  ok(h.calls.spawn[0].signal === exec.signal, 'bash foreground threads exec.signal')

  const bg = await bash.execute({ command: 'sleep 10', run_in_background: true }, exec)
  eq(h.calls.jobsStart.length, 1, 'background bash uses jobs.start')
  match(bg, /bash-1/, 'background bash returns bash_id')
  const bgSpawn = h.calls.spawn[1]
  ok(bgSpawn, 'background bash also spawned')
  eq(bgSpawn.signal, undefined, 'background bash spawn carries no exec.signal')

  const bash_output = h.registered.get('bash_output')
  const out = await bash_output.execute({ bash_id: 'bash-1' }, exec)
  eq(h.calls.jobsRead.length, 1, 'bash_output → jobs.read')
  match(out, /minimax-ok/, 'bash_output returns job output')

  const filtered = await bash_output.execute({ bash_id: 'bash-1', filter_str: 'nope' }, exec)
  eq(h.calls.jobsRead.length, 2, 'bash_output filter path still reads the job')
  match(filtered, /\[running\]/, 'empty filter match falls back to status marker')

  const bash_kill = h.registered.get('bash_kill')
  const killed = await bash_kill.execute({ bash_id: 'bash-1' }, exec)
  eq(h.calls.jobsKill.length, 1, 'bash_kill → jobs.kill')
  eq(h.calls.jobsKill[0].id, 'bash-1', 'bash_kill id')
  match(killed, /Terminated bash-1/, 'bash_kill confirmation')

  const missing = await bash_kill.execute({ bash_id: 'no-such' }, exec)
  match(missing, /Shell not found/, 'bash_kill unknown id is honest')

  const record_note = h.registered.get('record_note')
  const recall_notes = h.registered.get('recall_notes')
  await record_note.execute({ content: 'remember this', category: 'decision' }, exec)
  const notes = await recall_notes.execute({ category: 'decision' }, exec)
  match(notes, /remember this/, 'record_note/recall_notes round-trip')

  console.log('dsh-kernel-minimax smoke: ' + assertionCount + ' assertions ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
