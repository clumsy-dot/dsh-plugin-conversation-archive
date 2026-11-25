/**
 * Behaviour tests for the plugin, run with `node --test`.
 *
 * The plugin talks to the Harness only through its `ctx` services, so the tests
 * build a fake context with an in-memory filesystem and drive the registrations
 * the plugin makes: the prompt context, the `archive_outputs` tool, and the
 * `agent/created` / `tools/result` / `agent/turn-stopping` handlers.
 *
 * Nothing here touches the real filesystem or a real Session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join, sep } from 'node:path'
import { apply } from '../index.js'

const ROOT = process.platform === 'win32' ? `${'D:'}${sep}ws` : '/ws'
const SESSION_ID = 'session-test-0001'
const CREATED_AT = new Date(2026, 10, 22, 10, 0, 0).getTime()
const SESSION_DATE = '2026-11-22'

/**
 * Build a fake filesystem whose entries are keyed by absolute path.
 * @param {Record<string, { type?: 'file' | 'directory', size?: number, binary?: boolean }>} initial - entries below ROOT.
 * @returns the fake filesystem plus its mutation log.
 */
function createFileSystem(initial = {}) {
  const files = new Map()
  const moved = []
  const real = ROOT
  files.set(real, { type: 'directory' })
  for (const [name, meta] of Object.entries(initial)) {
    files.set(join(real, name), { type: meta.type ?? 'file', size: meta.size ?? 10, binary: meta.binary === true })
  }
  const fs = {
    async resolve(path) {
      return { displayPath: path, targetKey: path }
    },
    async listDir(target) {
      const directory = target.displayPath
      if (!files.has(directory) || files.get(directory).type !== 'directory') {
        throw Object.assign(new Error(`cannot list ${directory}`), { code: 'FS_NOT_FOUND' })
      }
      const children = []
      for (const [path, meta] of files) {
        if (path === directory || dirname(path) !== directory) continue
        children.push({ name: path.slice(directory.length + 1), type: meta.type, size: meta.size, binary: meta.binary, target: { displayPath: path, targetKey: path } })
      }
      return children
    },
    async stat(target) {
      const meta = files.get(target.displayPath)
      return meta === undefined ? undefined : { version: 'v1', type: meta.type, size: meta.size }
    },
    async moveFile(source, destination) {
      const meta = files.get(source.displayPath)
      if (meta === undefined) throw Object.assign(new Error('source vanished'), { code: 'FS_NOT_FOUND' })
      if (meta.binary === true) throw Object.assign(new Error('binary file'), { code: 'FS_NOT_TEXT' })
      if (files.has(destination.displayPath)) throw Object.assign(new Error('destination exists'), { code: 'FS_STALE_VERSION' })
      const parent = dirname(destination.displayPath)
      if (!files.has(parent)) files.set(parent, { type: 'directory' })
      files.delete(source.displayPath)
      files.set(destination.displayPath, meta)
      moved.push({ from: source.displayPath, to: destination.displayPath })
    },
  }
  return { fs, files, moved }
}

/**
 * A subprocess stand-in that records the argv it was asked to run.
 * @returns the fake service plus its call log.
 */
function createSubprocess() {
  const calls = []
  return {
    calls,
    async terminalEnvironment() {
      return { platform: process.platform === 'win32' ? 'windows' : 'posix' }
    },
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      calls.push(spec.argv)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        collected: {},
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
      }
    },
  }
}

/**
 * Build a fake Harness context for one plugin instance.
 * @param {{ config?: object, files?: Record<string, object>, firstPrompt?: string, services?: object }} options - initial state.
 * @returns the harness: the fake agent, captured registrations, and helpers.
 */
function createHarness(options = {}) {
  const { fs, files, moved } = createFileSystem(options.files ?? {})
  const warnings = []
  const handlers = new Map()
  let promptContext
  let tool

  const session = {
    id: SESSION_ID,
    header: { createdAt: CREATED_AT, cwd: ROOT },
    snapshotEvents: () => {
      if (Array.isArray(options.events)) return options.events
      return options.firstPrompt === undefined
        ? []
        : [{ type: 'user/message', data: { content: [{ type: 'text', text: options.firstPrompt }] } }]
    },
  }
  const agent = { id: SESSION_ID, session }

  const ctx = {
    fs,
    workingDirectory: { get: () => ROOT },
    get: name => options.services?.[name],
    systemPrompt: {
      context: definition => {
        promptContext = definition
        return () => {}
      },
    },
    tools: {
      register: definition => {
        tool = definition
        return () => {}
      },
    },
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => {}
    },
    logger: { warn: message => warnings.push(String(message)) },
  }

  apply(ctx, options.config ?? {})

  return {
    agent,
    session,
    files,
    moved,
    warnings,
    tool,
    /** Render the prompt context exactly as the Harness would. */
    guidance: () => promptContext.text({ agent, scope: agent }),
    /** Run the tool as the model would. */
    callTool: async args => tool.execute(args, { agent }),
    /** Fire one Harness event. */
    fire: async (event, payload) => handlers.get(event)?.(payload),
    /** Record a tool result the way the Harness reports one. */
    toolResult: payload => handlers.get('tools/result')?.(payload),
    /** Deliver a user message carrying attachments. */
    userMessage: content => handlers.get('session/event')?.(session, { type: 'user/message', data: { content } }),
  }
}

/**
 * Wait for the plugin's async handlers to settle.
 * @returns a resolved promise after one macrotask turn.
 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('unnamed conversation gets the naming rule, not a guess', async () => {
  const h = createHarness({ firstPrompt: '把题库整理成表格' })
  await h.fire('agent/created', { agent: h.agent })
  const text = h.guidance()
  assert.match(text, /2026-11-22_<主题>/)
  assert.match(text, /不超过 12 个字/)
  assert.doesNotMatch(text, /今天/)
})

test('a tool topic names and freezes the folder before any tool ran', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  const result = await h.callTool({ topic: '发布清单' })
  assert.equal(result.folder, join(ROOT, '2026-11-22_发布清单'))
  assert.match(h.guidance(), /2026-11-22_发布清单/)
})

test('illegal characters in a topic never reach the folder name', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  const result = await h.callTool({ topic: 'a/b:c*d?e"f<g>h|i' })
  const name = result.folder.slice(ROOT.length + 1)
  assert.doesNotMatch(name, /[<>:"/\\|?*]/)
  assert.match(name, /^2026-11-22_/)
})

test('the first sweep only records the baseline', async () => {
  const h = createHarness({ files: { 'old.txt': {} } })
  const result = await h.callTool({ paths: [] })
  assert.equal(result.moved.length, 0)
  assert.match(result.skipped[0].reason, /基线/)
})

test('a folder the conversation wrote into is adopted on the next turn', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  // The model writes a deliverable into a folder it named itself.
  h.files.set(join(ROOT, '2026-11-22_题库转换'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_题库转换', 'data.csv'), { type: 'file', size: 12 })
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, '2026-11-22_题库转换', 'data.csv') } })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.match(h.guidance(), /2026-11-22_题库转换/)
})

test('a folder another conversation created is never adopted', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  h.files.set(join(ROOT, '2026-11-22_别人的产物'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_别人的产物', 'x.txt'), { type: 'file', size: 5 })
  h.toolResult({ agent: h.agent, name: 'read', arguments: { file_path: join(ROOT, '2026-11-22_别人的产物', 'x.txt') } })
  // Reading does not count as ownership; only writing or naming does.
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, '2026-11-22_自己的.md') } })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  const text = h.guidance()
  assert.doesNotMatch(text, /别人的产物/)
})

test('a folder named inside a script command counts as this conversation\'s', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  h.files.set(join(ROOT, '2026-11-22_脚本产出'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_脚本产出', 'report.xlsx'), { type: 'file', size: 100, binary: true })
  h.toolResult({
    agent: h.agent,
    name: 'pwsh',
    arguments: { command: 'python build.py --out 2026-11-22_脚本产出/report.xlsx' },
  })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.match(h.guidance(), /2026-11-22_脚本产出/)
})

test('a stray root file is moved into the folder, and names never collide', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, '2026-11-22_报告', 'a.md') } })
  h.files.set(join(ROOT, '2026-11-22_报告'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_报告', 'a.md'), { type: 'file', size: 3 })
  // Two same-named files: one already inside, one at the root to be swept.
  h.files.set(join(ROOT, 'summary.md'), { type: 'file', size: 7 })
  h.files.set(join(ROOT, '2026-11-22_报告', 'summary.md'), { type: 'file', size: 9 })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  const movedNames = h.moved.map(entry => entry.to.slice(join(ROOT, '2026-11-22_报告').length + 1))
  assert.deepEqual(movedNames, ['summary (2).md'])
  assert.equal(h.files.has(join(ROOT, 'summary.md')), false)
})

test('a turn that ran no tool skips the directory walk entirely', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(h.moved.length, 0)
  // Nothing was even read, so the folder was never named or created.
  assert.equal([...h.files.keys()].filter(path => path.includes(SESSION_DATE)).length, 0)
})

test('ignored and dot files stay where they are', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  h.files.set(join(ROOT, '2026-11-22_报告'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_报告', 'a.md'), { type: 'file', size: 3 })
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, '2026-11-22_报告', 'a.md') } })
  h.files.set(join(ROOT, '.env'), { type: 'file', size: 4 })
  h.files.set(join(ROOT, '~$draft.docx'), { type: 'file', size: 4 })
  h.files.set(join(ROOT, 'notes.log'), { type: 'file', size: 4 })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(h.moved.length, 0)
  for (const name of ['.env', '~$draft.docx', 'notes.log']) assert.equal(h.files.has(join(ROOT, name)), true)
})

test('paths outside the root are refused with a reason', async () => {
  const h = createHarness()
  await h.fire('agent/created', { agent: h.agent })
  h.files.set(join(ROOT, 'sub'), { type: 'directory' })
  h.files.set(join(ROOT, 'sub', 'inner.txt'), { type: 'file', size: 4 })
  const result = await h.callTool({ paths: ['missing.txt', 'sub', 'sub/inner.txt'] })
  assert.equal(result.moved.length, 0)
  const reasons = result.skipped.map(entry => entry.reason)
  assert.ok(reasons.some(reason => reason.includes('没有这个文件')))
  assert.ok(reasons.some(reason => reason.includes('不是普通文件')))
  assert.ok(reasons.some(reason => reason.includes('不是工作区根目录')))
})

test('a binary file is reported when the shell is unavailable', async () => {
  const h = createHarness({ config: { maxTextMoveBytes: 1 } })
  await h.fire('agent/created', { agent: h.agent })
  h.files.set(join(ROOT, '2026-11-22_报告'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_报告', 'a.md'), { type: 'file', size: 3 })
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, '2026-11-22_报告', 'a.md') } })
  h.files.set(join(ROOT, 'big.bin'), { type: 'file', size: 999 })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(h.files.has(join(ROOT, 'big.bin')), true)
  assert.ok(h.warnings.some(line => line.includes('big.bin')))
})

test('a missing guidance switch registers no prompt context', async () => {
  const h = createHarness({ config: { guidance: false } })
  await flush()
  assert.throws(() => h.guidance(), /undefined|not a function/)
})

test('invalid config values fall back to defaults with a warning', async () => {
  const h = createHarness({ config: { topicMaxChars: 'lots', autoArchive: 'yes' } })
  assert.ok(h.warnings.some(line => line.includes('topicMaxChars')))
  assert.ok(h.warnings.some(line => line.includes('autoArchive')))
})

test('autoArchive=false leaves the turn end alone but keeps the tool working', async () => {
  const h = createHarness({ config: { autoArchive: false } })
  await h.fire('agent/created', { agent: h.agent })
  h.files.set(join(ROOT, '2026-11-22_报告'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_报告', 'a.md'), { type: 'file', size: 3 })
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, '2026-11-22_报告', 'a.md') } })
  h.files.set(join(ROOT, 'stray.txt'), { type: 'file', size: 4 })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(h.files.has(join(ROOT, 'stray.txt')), true, 'the turn end must not move anything')
  const result = await h.callTool({ paths: ['stray.txt'] })
  assert.equal(result.moved.length, 1)
  assert.equal(h.files.has(join(ROOT, 'stray.txt')), false)
})

test('includeSubagents=false leaves subagent sessions alone', async () => {
  const h = createHarness({ config: { includeSubagents: false } })
  h.session.header.origin = 'subagent'
  await h.fire('agent/created', { agent: h.agent })
  assert.equal(h.guidance(), '')
  h.files.set(join(ROOT, 'stray.txt'), { type: 'file', size: 4 })
  h.toolResult({ agent: h.agent, name: 'write', arguments: { file_path: join(ROOT, 'out.txt') } })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(h.moved.length, 0)
})

test('a file the user attached is copied into the conversation folder by default', async () => {
  const subprocess = createSubprocess()
  const storePath = join(sep, 'store', 'att-1', 'data.csv')
  const attachments = { fileHostPath: () => storePath }
  const h = createHarness({ firstPrompt: '整理这份附件', services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'att-1', name: 'data.csv', bytes: 120 } }])
  // The user attached a file and asked nothing else yet: no tool ran this turn.
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(subprocess.calls.length, 1, 'the transfer must run even without other tools')
  const argv = subprocess.calls[0].join(' ')
  assert.match(argv, /Copy-Item|cp -f/, 'the default keeps the original attachment')
  assert.ok(argv.includes(join(ROOT, '2026-11-22_整理这份附件', 'data.csv')), argv)
  assert.match(h.guidance(), /2026-11-22_整理这份附件/, 'handling a user file settles the folder')
})

test('userFileTransfer=move moves the file and the prompt records the new path', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: () => join(sep, 'store', 'mv', 'spec.pdf') }
  const h = createHarness({ config: { userFileTransfer: 'move' }, firstPrompt: '看图纸', services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'm1', name: 'spec.pdf', bytes: 9 } }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.match(subprocess.calls[0].join(' '), /Move-Item|mv -f/)
  assert.match(h.guidance(), /spec\.pdf → 2026-11-22_看图纸\/spec\.pdf/)
})

test('a second attachment with the same name never overwrites the first', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: ref => join(sep, 'store', ref.attachmentId, 'data.csv') }
  const h = createHarness({ firstPrompt: '整理附件', services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'a1', name: 'data.csv', bytes: 10 } }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  // The first copy now exists in the folder, so the second needs another name.
  h.files.set(join(ROOT, '2026-11-22_整理附件'), { type: 'directory' })
  h.files.set(join(ROOT, '2026-11-22_整理附件', 'data.csv'), { type: 'file', size: 10 })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'a2', name: 'data.csv', bytes: 10 } }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  const argv = subprocess.calls.at(-1).join(' ')
  assert.ok(argv.includes('data (2).csv'), argv)
})

test('pasted images stay out unless includeUserImages is on', async () => {
  const subprocess = createSubprocess()
  const attachments = { imageHostPath: () => join(sep, 'store', 'img', 'shot.png') }
  const off = createHarness({ services: { attachments, subprocess } })
  await off.fire('agent/created', { agent: off.agent })
  off.userMessage([{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 40 } }])
  await off.fire('agent/turn-stopping', { agent: off.agent })
  assert.equal(subprocess.calls.length, 0)

  const on = createHarness({ config: { includeUserImages: true }, services: { attachments, subprocess } })
  await on.fire('agent/created', { agent: on.agent })
  on.userMessage([{ type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 40 } }])
  await on.fire('agent/turn-stopping', { agent: on.agent })
  const argv = subprocess.calls.at(-1).join(' ')
  assert.ok(argv.includes('image-img-1.png'), argv)
  // Images are re-read by the Harness through the store, so they are never moved.
  assert.match(argv, /Copy-Item|cp -f/, 'an image must be copied even in move mode')
})

test('the prompt tells the model where a moved attachment now lives', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: () => join(sep, 'store', 'z', 'spec.pdf') }
  const h = createHarness({ firstPrompt: '看这份图纸', services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'f1', name: 'spec.pdf', bytes: 9 } }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  const text = h.guidance()
  assert.match(text, /用户提供的文件也在该目录/)
  assert.match(text, /spec\.pdf → 2026-11-22_看这份图纸\/spec\.pdf/)
})

test('an attachment with no local path is reported, not silently dropped', async () => {
  const h = createHarness({ firstPrompt: '看附件', services: { attachments: {} } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'att-9', name: 'remote.bin', bytes: 5 } }])
  const result = await h.callTool({ paths: [] })
  assert.equal(result.userFiles.length, 0)
  assert.ok(result.skipped.some(entry => entry.reason.includes('不在本机存储')))
})

test('includeUserFiles=false ignores user attachments entirely', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: () => join(sep, 'store', 'a1', 'x.txt') }
  const h = createHarness({ config: { includeUserFiles: false }, services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'a1', name: 'x.txt', bytes: 3 } }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(subprocess.calls.length, 0)
})

test('attachments already in the session log are archived after a reload', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: ref => join(sep, 'store', ref.attachmentId, 'old.csv') }
  const h = createHarness({
    services: { attachments, subprocess },
    events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: '看这个附件' }] } },
      { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: 'old-1', name: 'old.csv', bytes: 8 } }] } },
    ],
  })
  // A reloaded plugin re-reads the log when the agent is created.
  await h.fire('agent/created', { agent: h.agent })
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(subprocess.calls.length, 1)
  assert.ok(subprocess.calls[0].join(' ').includes('old.csv'))
})

test('the tool result reports the transfer action and destination', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: () => join(sep, 'store', 'x', 'a.txt') }
  const h = createHarness({ firstPrompt: '附件', services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'a', name: 'a.txt', bytes: 3 } }])
  const result = await h.callTool({ paths: [] })
  assert.deepEqual(result.userFiles, [{ from: 'a.txt', to: '2026-11-22_附件/a.txt', action: 'copy' }])
})

test('an explicit copy mode reports action copy and keeps the original', async () => {
  const subprocess = createSubprocess()
  const attachments = { fileHostPath: () => join(sep, 'store', 'y', 'keep.txt') }
  const h = createHarness({ config: { userFileTransfer: 'copy' }, services: { attachments, subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'file', attachment: { attachmentId: 'k', name: 'keep.txt', bytes: 3 } }])
  const result = await h.callTool({ paths: [] })
  assert.equal(result.userFiles[0].action, 'copy')
  assert.match(subprocess.calls[0].join(' '), /Copy-Item|cp -f/)
})

test('a file the user references with @path outside the workspace is copied in', async () => {
  const subprocess = createSubprocess()
  const outside = process.platform === 'win32' ? `C:${sep}dl${sep}通知.pdf` : '/dl/通知.pdf'
  const h = createHarness({ firstPrompt: '看这份通知', services: { subprocess } })
  h.files.set(outside, { type: 'file', size: 2048 })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'text', text: `@${outside} 帮我做个选题对比` }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(subprocess.calls.length, 1, 'a referenced file must be copied')
  const argv = subprocess.calls[0].join(' ')
  assert.match(argv, /Copy-Item|cp -f/)
  assert.ok(argv.includes(join(ROOT, '2026-11-22_看这份通知', '通知.pdf')), argv)
  assert.match(h.guidance(), /通知\.pdf → 2026-11-22_看这份通知\/通知\.pdf/)
})

test('a referenced path inside the workspace is not copied again', async () => {
  const subprocess = createSubprocess()
  const h = createHarness({ firstPrompt: '看代码', services: { subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'text', text: '@src/index.ts 这里有问题' }])
  await h.fire('agent/turn-stopping', { agent: h.agent })
  assert.equal(subprocess.calls.length, 0)
})

test('a referenced path that does not exist is ignored silently', async () => {
  const subprocess = createSubprocess()
  const missing = process.platform === 'win32' ? `C:${sep}dl${sep}gone.pdf` : '/dl/gone.pdf'
  const h = createHarness({ firstPrompt: '看附件', services: { subprocess } })
  await h.fire('agent/created', { agent: h.agent })
  h.userMessage([{ type: 'text', text: `@${missing}` }])
  const result = await h.callTool({ paths: [] })
  assert.equal(subprocess.calls.length, 0)
  assert.equal(result.userFiles.length, 0)
  assert.equal(result.skipped.length, 0)
})
