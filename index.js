/**
 * conversation-archive — keep each conversation's generated files inside one
 * folder named `<YYYY-MM-DD>_<topic>` in the Session working directory instead
 * of scattering them in its root.
 *
 * Two mechanisms cooperate:
 * 1. Guidance: a prompt runtime context tells the model the exact folder for
 *    this conversation and that deliverables belong there, so files are usually
 *    created in the right place in the first place.
 * 2. Sweep: files that still appear in the working-directory root during the
 *    conversation are moved into that folder at the end of the turn (and on
 *    demand through the `archive_outputs` tool).
 *
 * Only the root of the working directory is ever touched, never directories and
 * never files that already existed when the conversation started. Relocation
 * uses `ctx.fs.moveFile` for text files and a shell rename for binary or large
 * ones, because the filesystem seam only reads and writes UTF-8 text.
 */
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Stable Loader identity. */
export const name = 'conversation-archive'

/** Prompt context placement: after the runtime facts owned by the Harness. */
const CONTEXT_ORDER = 130

/** Context registry name. */
const CONTEXT_NAME = 'conversation-archive'

/** Hard service dependencies. */
export const inject = ['fs', 'workingDirectory', 'systemPrompt', 'tools']

/** Every tunable, with its deployment default. */
const DEFAULTS = {
  enabled: true,
  autoArchive: true,
  guidance: true,
  baseDir: '',
  topicMaxChars: 12,
  skipDotEntries: true,
  ignorePatterns: ['.git', 'node_modules', '~$*', '*.tmp', '*.log'],
  maxTextMoveBytes: 2 * 1024 * 1024,
  turnEndBudgetMs: 8000,
  includeSubagents: true,
  includeUserFiles: true,
  includeUserImages: false,
  userFileTransfer: 'move',
  maxUserCopyBytes: 20 * 1024 * 1024,
}

/** Windows device names may not be used as a folder name. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** A conversation folder the model created for itself: a date prefix and a topic. */
const DATED_FOLDER = /^\d{4}-\d{2}-\d{2}_./u

/** Keys under which a tool call names the file it targets. */
const PATH_KEYS = /^(?:file_?path|path|file|target|destination|output_?path|dst|src)$/iu

/**
 * Tools that can create output. Only these count towards owning a folder:
 * reading, searching, or listing another conversation's folder must not make
 * this conversation adopt it.
 */
const WRITER_TOOL = /write|edit|patch|create|save|export|generate|convert|render|office|sheet|doc|pdf|bash|pwsh|shell|terminal|exec|run|script|code|apply/iu

/** Openers that carry no summarizing value once the topic is truncated. */
const FILLER_OPENER = /^(?:请|麻烦|帮我|帮忙|给我|我想|我想要|我需要|能不能|可以|希望|做一个|写一个|搞一个|弄一个)+/u

/** Characters no Windows path segment may contain (control codes included). */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g

/**
 * Merge the Loader row's config over the defaults, keeping only usable values.
 * An unusable value is reported once and replaced by its default.
 * @param raw - the row config object, possibly absent or malformed.
 * @param warn - sink for a human-readable diagnostic.
 * @returns the effective configuration.
 */
function resolveConfig(raw, warn) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULTS }
  const pick = (key, test, coerce) => {
    if (!(key in source)) return
    const value = source[key]
    if (test(value)) config[key] = coerce === undefined ? value : coerce(value)
    else warn(`config "${key}" is invalid; using ${JSON.stringify(DEFAULTS[key])}`)
  }
  const isBool = value => typeof value === 'boolean'
  const isString = value => typeof value === 'string'
  const isNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  pick('enabled', isBool)
  pick('autoArchive', isBool)
  pick('guidance', isBool)
  pick('skipDotEntries', isBool)
  pick('includeSubagents', isBool)
  pick('includeUserFiles', isBool)
  pick('includeUserImages', isBool)
  pick('userFileTransfer', value => value === 'move' || value === 'copy')
  pick('baseDir', isString)
  pick('maxUserCopyBytes', isNumber, value => Math.floor(value))
  pick('topicMaxChars', value => isNumber(value) && value >= 1, value => Math.floor(value))
  pick('maxTextMoveBytes', isNumber, value => Math.floor(value))
  pick('turnEndBudgetMs', isNumber, value => Math.floor(value))
  pick('ignorePatterns', value => Array.isArray(value) && value.every(entry => typeof entry === 'string'))
  config.ignorePatterns = config.ignorePatterns.map(entry => entry.trim()).filter(entry => entry.length > 0)
  return config
}

/**
 * Render one timestamp as a local calendar date.
 * @param timestamp - epoch milliseconds, or anything else for "now".
 * @returns `YYYY-MM-DD`.
 */
function formatDate(timestamp) {
  const date = new Date(typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now())
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Reduce arbitrary conversation text to one filesystem-safe folder fragment.
 * @param input - a session title or the first user prompt.
 * @param maxChars - maximum kept code points.
 * @returns a non-empty folder fragment without separators or trailing dots.
 */
function sanitizeTopic(input, maxChars) {
  let text = typeof input === 'string' ? input : ''
  text = text.split(/\r?\n/u)[0] ?? ''
  text = text.replace(/```[\s\S]*?```/gu, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
  text = text.replace(/[#*>`~]+/gu, ' ')
  text = text.replace(ILLEGAL_CHARS, '-')
  text = text.replace(/[\s\u3000]+/gu, '-').replace(/-{2,}/gu, '-')
  text = text.replace(/^[.\-\s]+|[.\-\s]+$/gu, '')
  text = Array.from(text).slice(0, Math.max(1, maxChars)).join('')
  text = text.replace(/^[.\-\s]+|[.\-\s]+$/gu, '')
  if (text.length === 0) text = 'untitled'
  if (RESERVED_NAME.test(text)) text = `_${text}`
  return text.slice(0, 60)
}

/**
 * Reduce a prompt or title to the clause that best stands in for a summary:
 * the first short sentence with a leading filler opener removed.
 * @param text - raw title, prompt, or tool-supplied topic.
 * @returns the clause to sanitize.
 */
function provisionalTopic(text) {
  const whole = typeof text === 'string' ? text : ''
  const firstClause = whole.split(/[。！!？?；;，,、：:\n]/u)[0] ?? ''
  const clause = firstClause.trim().length > 0 ? firstClause : whole
  return clause.trim().replace(FILLER_OPENER, '').trim()
}

/**
 * Join the conversation date and topic into one folder name.
 * @param date - `YYYY-MM-DD` of the conversation.
 * @param topic - raw title, prompt clause, or explicit topic.
 * @param maxChars - maximum topic code points.
 * @returns the folder basename.
 */
function buildFolderName(date, topic, maxChars) {
  return `${date}_${sanitizeTopic(provisionalTopic(topic), maxChars)}`
}

/**
 * Extract the text of a message's blocks.
 * @param message - any message-shaped record.
 * @returns the concatenated text, or an empty string.
 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Read the first user-authored message of a session for topic fallback.
 * @param session - live session whose log is the source of truth.
 * @returns the first non-empty user text, or an empty string.
 */
function firstUserText(session) {
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return ''
  }
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const text = messageText(event.data)
    if (text.length > 0) return text
  }
  return ''
}

/**
 * Collect the files a user's message attached, in the order they appear.
 * @param message - a `user/message` payload.
 * @param includeImages - whether pasted images also count as provided files.
 * @returns records carrying the attachment ref, a suggested name, and its kind.
 */
function attachmentsIn(message, includeImages) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  const found = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const attachment = block.attachment
    if (attachment === undefined || attachment === null) continue
    if (block.type === 'file') {
      const name = typeof attachment.name === 'string' && attachment.name.trim().length > 0 ? attachment.name.trim() : 'attachment'
      found.push({ kind: 'file', ref: attachment, name })
      continue
    }
    if (includeImages && block.type === 'image') {
      const extension = typeof attachment.mediaType === 'string' && attachment.mediaType.includes('/')
        ? attachment.mediaType.split('/')[1]
        : 'png'
      const name = typeof attachment.name === 'string' && attachment.name.trim().length > 0
        ? attachment.name.trim()
        : `image-${String(attachment.attachmentId ?? '').slice(0, 8)}.${extension}`
      found.push({ kind: 'image', ref: attachment, name })
    }
  }
  return found
}

/**
 * Test a root entry name against the ignore patterns.
 * Supports `*` inside one segment, otherwise a literal match.
 * @param patterns - effective pattern list.
 * @param candidate - root entry basename.
 * @returns whether the entry is ignored.
 */
function isIgnored(patterns, candidate) {
  for (const pattern of patterns) {
    if (pattern === candidate) return true
    if (!pattern.includes('*')) continue
    const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[\\s\\S]*')
    if (new RegExp(`^${escaped}$`, 'iu').test(candidate)) return true
  }
  return false
}

/**
 * Collect the file paths a tool call names, at any depth of its arguments.
 * @param value - parsed tool arguments.
 * @param out - accumulator.
 * @param depth - recursion guard.
 * @returns the raw path strings found.
 */
function pathValues(value, out = [], depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) pathValues(item, out, depth + 1)
    return out
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      if (PATH_KEYS.test(key)) out.push(entry)
    } else if (entry !== null && typeof entry === 'object') {
      pathValues(entry, out, depth + 1)
    }
  }
  return out
}

/**
 * Collect the conversation folder names a tool call mentions anywhere in its
 * arguments — including a path embedded in a generated script, which is how
 * non-text deliverables usually land in their folder.
 * @param value - parsed tool arguments.
 * @param out - accumulator of folder basenames.
 * @param depth - recursion guard.
 * @returns the mentioned folder names.
 */
function mentionedFolders(value, out = new Set(), depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) mentionedFolders(item, out, depth + 1)
    return out
  }
  for (const entry of Object.values(value)) {
    if (typeof entry === 'string') {
      if (entry.length > 20000) continue
      for (const match of entry.matchAll(/\d{4}-\d{2}-\d{2}_[^\s"'`/\\<>|:*?]+/gu)) out.add(match[0])
    } else if (entry !== null && typeof entry === 'object') {
      mentionedFolders(entry, out, depth + 1)
    }
  }
  return out
}

/**
 * Quote one path as a PowerShell single-quoted literal.
 * @param value - raw path text.
 * @returns the quoted literal.
 */
function psQuote(value) {
  return `'${value.replace(/'/gu, "''")}'`
}

/**
 * Quote one path as a POSIX shell single-quoted word.
 * @param value - raw path text.
 * @returns the quoted word.
 */
function shQuote(value) {
  return `'${value.replace(/'/gu, "'\\''")}'`
}

/**
 * Read a collected child stream as text without throwing.
 * @param handle - spawned process handle.
 * @param stream - collector name.
 * @returns the collected text, or an empty string.
 */
function collectedText(handle, stream) {
  try {
    const collected = handle?.collected?.[stream]
    const page = collected?.readFrom(0)
    return typeof page?.text === 'string' ? page.text : ''
  } catch {
    return ''
  }
}

/**
 * Resolve a working directory that is safe to join onto.
 * @param workingDirectory - the service providing the committed directory.
 * @param session - the session whose directory is asked for.
 * @returns an absolute directory path.
 */
function sessionDirectory(workingDirectory, session) {
  try {
    const directory = workingDirectory.get(session)
    if (typeof directory === 'string' && directory.length > 0) return directory
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd()
}

/**
 * @param ctx - the plugin context.
 * @param rawConfig - the Loader row's config.
 */
export function apply(ctx, rawConfig) {
  /** Per-session state; a cache derived from the session log and the root listing. */
  const states = new Map()

  /** Files the user attached in each conversation, keyed by session id. */
  const sessionAttachments = new Map()

  /**
   * Report a non-fatal problem without disturbing the caller.
   * @param message - what happened.
   */
  function warn(message) {
    try {
      ctx.logger.warn(`conversation-archive: ${message}`)
    } catch {
      /* a missing logger must never break the plugin */
    }
  }

  const opts = resolveConfig(rawConfig, message => warn(message))

  /**
   * Whether this session takes part at all.
   * @param agent - the agent to inspect.
   * @returns participation flag.
   */
  function participates(agent) {
    const session = agent?.session
    if (session === undefined || session === null) return false
    if (opts.includeSubagents) return true
    const header = session.header ?? {}
    return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
  }

  /**
   * Read or create the state for one agent.
   * @param agent - the agent being served.
   * @returns its mutable state record.
   */
  function stateOf(agent) {
    let state = states.get(agent.id)
    if (state !== undefined) return state
    if (states.size >= 256) {
      const oldest = states.keys().next().value
      if (oldest !== undefined) states.delete(oldest)
    }
    state = {
      date: formatDate(agent.session?.header?.createdAt),
      folder: null,
      adopted: null,
      frozen: false,
      fallbackTopic: null,
      baseline: null,
      writes: new Set(),
      mentions: new Set(),
      dirty: false,
      moved: [],
      userFiles: [],
      busy: false,
    }
    states.set(agent.id, state)
    return state
  }

  /**
   * Absolute directory that holds the conversation folder.
   * @param agent - the agent whose session directory applies.
   * @returns absolute base directory.
   */
  function baseDirOf(agent) {
    const directory = sessionDirectory(ctx.workingDirectory, agent.session)
    if (opts.baseDir.length === 0) return directory
    return resolve(directory, opts.baseDir)
  }

  /**
   * The folder this conversation already settled on, if any.
   * @param state - the conversation state.
   * @returns the adopted folder the model created, else a frozen folder, else null.
   */
  function settledFolder(state) {
    if (typeof state.adopted === 'string' && state.adopted.length > 0) return state.adopted
    if (state.frozen && typeof state.folder === 'string' && state.folder.length > 0) return state.folder
    return null
  }

  /**
   * Current folder basename: the settled one, else a provisional name derived
   * from the title or the first prompt.
   * @param agent - the agent being served.
   * @param state - its state record.
   * @returns the folder basename.
   */
  function folderOf(agent, state) {
    const settled = settledFolder(state)
    if (settled !== null) return settled
    let topic = ''
    try {
      const title = ctx.get('sessionTitle')?.get(agent.session)?.title
      if (typeof title === 'string' && title.trim().length > 0) topic = title
    } catch {
      /* a missing title service only costs the nicer name */
    }
    if (topic.length === 0) {
      // The first prompt is not committed at the very first assembly, so only a
      // non-empty read may be cached; otherwise the later read is used.
      if (state.fallbackTopic === null) {
        const first = firstUserText(agent.session)
        if (first.length > 0) state.fallbackTopic = first
        topic = first
      } else {
        topic = state.fallbackTopic
      }
    }
    if (topic.length === 0) topic = `session-${String(agent.id).replace(/^session-/, '').slice(0, 6)}`
    state.folder = buildFolderName(state.date, topic, opts.topicMaxChars)
    return state.folder
  }

  /**
   * Adopt the dated folder the model created for this conversation, so later
   * stray files join it instead of a folder of our own naming.
   * @param state - the conversation state.
   * @param entries - current root listing.
   * @param baseline - names known before this conversation.
   */
  function adoptDatedFolder(state, entries, baseline) {
    if (typeof state.adopted === 'string') return
    const candidates = entries.filter(entry => entry.type === 'directory' && DATED_FOLDER.test(entry.name) && !baseline.has(entry.name))
    if (candidates.length === 0) return
    // Only a folder this conversation itself wrote into — or named in a tool call,
    // such as a script that writes its output — counts as its own. Another
    // conversation working in the same directory keeps its folders unclaimed.
    const owned = candidates.filter(entry => state.mentions.has(entry.name)
      || [...state.writes].some(written => written.startsWith(`${entry.name}/`)))
    if (owned.length === 0) return
    const known = typeof state.folder === 'string' ? owned.find(entry => entry.name === state.folder) : undefined
    const chosen = known ?? owned.slice().sort((left, right) => left.name.localeCompare(right.name))[0]
    state.adopted = chosen.name
    state.frozen = true
  }

  /**
   * Capture the root listing that distinguishes conversation output from files
   * that were already there. The first call after a load wins, so a plugin
   * reload never sweeps a directory it never observed.
   *
   * A failed listing is NOT an empty baseline: treating it as empty would make
   * every existing file look newly generated on the next sweep.
   * @param agent - the agent being served.
   * @param state - its state record.
   * @returns the baseline names, or why the directory could not be read.
   */
  async function ensureBaseline(agent, state) {
    if (state.baseline !== null) return { names: state.baseline }
    const names = new Set()
    try {
      const target = await ctx.fs.resolve(baseDirOf(agent))
      for (const entry of await ctx.fs.listDir(target)) names.add(entry.name)
    } catch (error) {
      return { names: null, reason: error instanceof Error ? error.message : String(error) }
    }
    state.baseline = names
    return { names }
  }

  /**
   * Pick a destination path inside the folder that does not collide.
   * @param directory - absolute destination folder.
   * @param fileName - desired basename.
   * @returns the free absolute path.
   */
  async function freeDestination(directory, fileName) {
    const extension = extname(fileName)
    const stem = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const candidate = attempt === 1 ? fileName : `${stem} (${attempt})${extension}`
      const absolute = join(directory, candidate)
      const info = await ctx.fs.stat(await ctx.fs.resolve(absolute))
      if (info === undefined) return absolute
    }
    throw new Error(`目标目录里同名文件过多：${fileName}`)
  }

  /**
   * Move (or copy, when configured) the files the user attached to this
   * conversation into its folder, so the folder holds both what the model
   * produced and what the user handed over.
   * @param agent - the agent whose conversation is being served.
   * @param state - its state record.
   * @param base - absolute working directory.
   * @param folder - folder basename.
   * @param result - the sweep result to fill.
   * @param started - sweep start time, for the shared budget.
   */
  async function transferUserFiles(agent, state, base, folder, result, started) {
    if (!opts.includeUserFiles) return
    const recorded = sessionAttachments.get(agent.id)
    if (recorded === undefined || recorded.size === 0) return
    const pending = [...recorded.values()].filter(item => !item.done)
    if (pending.length === 0) return
    const attachments = ctx.get('attachments')
    const directory = join(base, folder)
    // A user file is reason enough to settle the folder name.
    if (settledFolder(state) === null) state.frozen = true
    for (const item of pending) {
      if (Date.now() - started > opts.turnEndBudgetMs) {
        result.skipped.push({ path: item.name, reason: '超出时间预算，下一次归拢重试' })
        continue
      }
      // Images are re-read by the Harness through the attachment store, so they
      // are always copied; a text/file attachment is re-read by path, and the
      // prompt tells the model where it went, so it may travel as a move.
      const mode = item.kind === 'image' || opts.userFileTransfer === 'copy' ? 'copy' : 'move'
      const verb = mode === 'copy' ? '复制' : '移动'
      try {
        if (attachments === undefined || attachments === null) throw new Error(`当前组合没有 attachments 服务，无法${verb}用户文件`)
        const hostPath = item.kind === 'image'
          ? attachments.imageHostPath?.(item.ref)
          : attachments.fileHostPath?.(item.ref)
        if (typeof hostPath !== 'string' || hostPath.length === 0) throw new Error(`该附件不在本机存储里，无法${verb}`)
        const bytes = typeof item.ref.bytes === 'number' ? item.ref.bytes : 0
        if (bytes > opts.maxUserCopyBytes) throw new Error(`附件 ${bytes} 字节，超过 maxUserCopyBytes=${opts.maxUserCopyBytes}`)
        const destination = await freeDestination(directory, item.name)
        await shellTransfer(hostPath, destination, mode)
        item.done = true
        const entry = { from: item.name, to: `${folder}/${basename(destination)}`, action: mode }
        result.userFiles.push(entry)
        state.userFiles.push(entry)
        if (state.userFiles.length > 40) state.userFiles.splice(0, state.userFiles.length - 40)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        result.skipped.push({ path: item.name, reason })
        warn(`${verb}用户提供的文件 ${item.name} 失败：${reason}`)
      }
    }
  }

  /**
   * Move or copy one file with the shell, which is the only path for binary content.
   * @param source - absolute source path.
   * @param destination - absolute destination path.
   * @param mode - `move` removes the source, `copy` keeps it.
   */
  async function shellTransfer(source, destination, mode) {
    const verb = mode === 'copy' ? '复制' : '移动'
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined || subprocess === null) throw new Error(`当前组合没有 subprocess 服务，无法${verb}二进制文件`)
    const environment = await subprocess.terminalEnvironment()
    const directory = dirname(destination)
    let argv
    if (environment?.platform === 'windows') {
      let executable
      for (const command of ['pwsh', 'powershell.exe']) {
        try {
          executable = await subprocess.resolveExecutable(command)
          break
        } catch {
          /* try the next PowerShell host */
        }
      }
      if (executable === undefined) throw new Error('找不到可用的 PowerShell')
      const operation = mode === 'copy' ? 'Copy-Item' : 'Move-Item'
      const script = `New-Item -ItemType Directory -Force -Path ${psQuote(directory)} | Out-Null; `
        + `${operation} -LiteralPath ${psQuote(source)} -Destination ${psQuote(destination)} -Force`
      argv = [executable, '-NoProfile', '-NonInteractive', '-Command', script]
    } else {
      const operation = mode === 'copy' ? `cp -f -- ${shQuote(source)} ${shQuote(destination)}` : `mv -f -- ${shQuote(source)} ${shQuote(destination)}`
      argv = ['/bin/sh', '-c', `mkdir -p -- ${shQuote(directory)} && ${operation}`]
    }
    const handle = subprocess.spawn({
      argv,
      cwd: dirname(source),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 3000,
    })
    // A serial turn-stopping listener may not hang on a stuck child.
    const limitMs = Math.min(Math.max(opts.turnEndBudgetMs, 3000), 15000)
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`系统命令超时（${limitMs}ms）`)), limitMs)
    })
    let outcome
    try {
      outcome = await Promise.race([handle.done, deadline])
    } catch (error) {
      try {
        handle.terminate()
      } catch {
        /* the child is already gone; the original failure is the one to report */
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (outcome?.exitCode !== 0) {
      const detail = collectedText(handle, 'stderr').trim()
      throw new Error(`系统命令${verb}失败（退出码 ${outcome?.exitCode ?? '未知'}）${detail.length > 0 ? `：${detail.slice(0, 200)}` : ''}`)
    }
  }

  /**
   * Move one root entry into the conversation folder.
   * @param entry - listed root entry.
   * @param destination - absolute destination path.
   * @returns whether the entry was moved; false when it disappeared first.
   */
  async function moveEntry(entry, destination) {
    const size = entry.size
    if (size === undefined || size <= opts.maxTextMoveBytes) {
      try {
        await ctx.fs.moveFile(entry.target, await ctx.fs.resolve(destination), {})
        return true
      } catch (error) {
        const code = error?.code
        /* A source that vanished has nothing left to move. */
        if (code === 'FS_NOT_FOUND') return false
        // Binary and oversized content cannot travel through the text seam, so this
        // fallback is routine; any other failure is worth reporting before retrying.
        if (code !== 'FS_NOT_TEXT' && code !== 'FS_TOO_LARGE') {
          warn(`文件工具移动 ${entry.name} 未成功（${error instanceof Error ? error.message : String(error)}），改用系统命令`)
        }
      }
    }
    await shellTransfer(entry.target.displayPath, destination, 'move')
    return true
  }

  /**
   * Move this conversation's root files into its folder.
   * @param agent - the agent whose session owns them.
   * @param request - optional explicit root-relative paths.
   * @returns what was moved and what was left alone.
   */
  async function sweep(agent, request = {}) {
    const state = stateOf(agent)
    const explicit = Array.isArray(request.paths) ? request.paths : null
    const requestedTopic = typeof request.topic === 'string' ? request.topic.trim() : ''
    const base = baseDirOf(agent)
    const result = { folder: join(base, folderOf(agent, state)), moved: [], userFiles: [], skipped: [] }
    if (state.busy) {
      result.skipped.push({ path: '*', reason: '一次归拢还没结束' })
      return result
    }
    // Naming the folder is honoured even before any tool ran: the call that names
    // it cannot have set the turn's "a tool ran" mark yet.
    if (requestedTopic.length > 0 && settledFolder(state) === null) {
      state.folder = buildFolderName(state.date, requestedTopic, opts.topicMaxChars)
      state.frozen = true
      result.folder = join(base, state.folder)
    }
    // Files the user attached must reach the folder even in a turn that ran no
    // tool, so a pending copy also earns the directory walk.
    const pendingUserFiles = opts.includeUserFiles && [...(sessionAttachments.get(agent.id)?.values() ?? [])].some(item => !item.done)
    // A turn that ran no tool cannot have produced conversation output, so the
    // per-turn directory walk is skipped for pure-conversation turns.
    if (explicit === null && !state.dirty && !pendingUserFiles) return result
    state.busy = true
    const started = Date.now()
    try {
      const isFirstObservation = state.baseline === null
      const baseline = await ensureBaseline(agent, state)
      if (baseline.names === null) {
        result.skipped.push({ path: '*', reason: `无法记录工作目录基线：${baseline.reason}` })
        return result
      }
      if (isFirstObservation) {
        const firstFolder = folderOf(agent, state)
        result.folder = join(base, firstFolder)
        await transferUserFiles(agent, state, base, firstFolder, result, started)
        result.skipped.push({ path: '*', reason: '本轮只记录了目录基线，下一次归拢起生效' })
        return result
      }
      let entries
      try {
        entries = await ctx.fs.listDir(await ctx.fs.resolve(base))
      } catch (error) {
        result.skipped.push({ path: '*', reason: `无法列出工作目录：${error instanceof Error ? error.message : String(error)}` })
        return result
      }
      state.dirty = false
      adoptDatedFolder(state, entries, baseline.names)
      const folder = folderOf(agent, state)
      result.folder = join(base, folder)
      await transferUserFiles(agent, state, base, folder, result, started)
      const byName = new Map(entries.map(entry => [entry.name, entry]))
      const candidates = []
      const seen = new Set()
      if (explicit === null) {
        for (const entry of entries) {
          if (baseline.names.has(entry.name)) continue
          if (entry.type !== 'file') {
            baseline.names.add(entry.name)
            continue
          }
          if (opts.skipDotEntries && entry.name.startsWith('.')) {
            baseline.names.add(entry.name)
            continue
          }
          if (isIgnored(opts.ignorePatterns, entry.name)) {
            baseline.names.add(entry.name)
            continue
          }
          candidates.push(entry)
        }
      } else {
        for (const raw of explicit) {
          if (typeof raw !== 'string' || raw.trim().length === 0) {
            result.skipped.push({ path: String(raw), reason: '空路径' })
            continue
          }
          const absolute = isAbsolute(raw) ? raw : resolve(base, raw)
          const relativeName = relative(base, absolute)
          if (relativeName.length === 0 || relativeName.startsWith('..') || isAbsolute(relativeName) || relativeName.includes(sep)) {
            result.skipped.push({ path: raw, reason: '不是工作区根目录里的文件' })
            continue
          }
          const entry = byName.get(relativeName)
          if (entry === undefined) {
            result.skipped.push({ path: raw, reason: '根目录下没有这个文件' })
            continue
          }
          if (entry.type !== 'file') {
            result.skipped.push({ path: raw, reason: '不是普通文件' })
            continue
          }
          if (isIgnored(opts.ignorePatterns, entry.name)) {
            result.skipped.push({ path: raw, reason: '命中忽略规则' })
            continue
          }
          if (seen.has(entry.name)) continue
          seen.add(entry.name)
          candidates.push(entry)
        }
      }
      if (candidates.length === 0) return result
      const directory = join(base, folder)
      for (const entry of candidates) {
        if (Date.now() - started > opts.turnEndBudgetMs) {
          result.skipped.push({ path: entry.name, reason: '超出时间预算，下一次归拢重试' })
          continue
        }
        try {
          const destination = await freeDestination(directory, entry.name)
          if (!await moveEntry(entry, destination)) {
            /* Gone between the listing and the move: nothing left to report. */
            baseline.names.add(entry.name)
            continue
          }
          result.moved.push({ from: entry.name, to: `${folder}/${destination.slice(directory.length + 1)}` })
          baseline.names.add(entry.name)
          state.frozen = true
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          result.skipped.push({ path: entry.name, reason })
          warn(`移动 ${entry.name} 失败：${reason}`)
        }
      }
      if (result.moved.length > 0) {
        state.moved.push(...result.moved)
        if (state.moved.length > 40) state.moved.splice(0, state.moved.length - 40)
      }
      return result
    } finally {
      state.busy = false
    }
  }

  /**
   * Build the prompt section naming this conversation's folder.
   * @param agent - the agent the assembly is for.
   * @returns the section text, or an empty string when it does not apply.
   */
  function guidanceText(agent) {
    try {
      if (!participates(agent)) return ''
      const state = stateOf(agent)
      const base = baseDirOf(agent)
      const settled = settledFolder(state)
      if (settled !== null) {
        const path = join(base, settled)
        const lines = [
          '## 本次对话的产物目录',
          `${path}${sep}`,
          `- 你为用户产出的文件（文档、表格、图片、脚本、压缩包等）一律写到上面这个目录，引用时用 \`${settled}${sep}文件名\`；不要在 ${base} 根目录堆积新文件，也不要另建并列的顶层目录。`,
          '- 项目源码、仓库文件照旧留在它们自己的目录里，这条约定只管你新产出的交付文件。',
          `- 用户发给你的附件会被放进这个目录：文件类默认${opts.userFileTransfer === 'copy' ? '复制副本' : '搬入'}、图片类保留副本；要再看内容就按目录里的路径读。`,
          '- 临时中间文件放系统临时目录，不要留在工作区。',
          '- 结束前如果工作区根目录还有本次新生成的文件，先调用 archive_outputs 把它们归拢进去。',
        ]
        if (state.moved.length > 0) {
          lines.push('- 已归拢到该目录：')
          for (const entry of state.moved.slice(-10)) lines.push(`  - ${entry.from} → ${entry.to}`)
        }
        if (state.userFiles.length > 0) {
          lines.push('- 用户提供的文件也在该目录（要再看内容就按这里的路径读）：')
          for (const entry of state.userFiles.slice(-10)) lines.push(`  - ${entry.from} → ${entry.to}${entry.action === 'copy' ? '（副本，原附件仍在）' : ''}`)
        }
        return lines.join('\n')
      }
      return [
        '## 本次对话的产物目录',
        `- 交付文件统一放在工作区下的一个文件夹里：\`${state.date}_<主题>\`（${state.date} 是本次对话的起始日期，多日会话继续用它）。\`<主题>\` 用不超过 ${opts.topicMaxChars} 个字概括这次对话在做的事（例如 \`题库转换\`、\`图标重绘\`），不要照抄提问原句。`,
        '- 本次对话只用一个这样的文件夹：第一次建好后，之后所有交付文件都放进它，引用时写 `<文件夹>/文件名`。',
        '- 临时中间文件放系统临时目录；不要把交付文件留在工作区根目录。',
        '- 想让我来建这个文件夹的话，调用 archive_outputs 并给出 topic。',
      ].join('\n')
    } catch (error) {
      warn(`提示词渲染失败：${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  if (opts.guidance) {
    ctx.systemPrompt.context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      interpolate: false,
      text: context => {
        const agent = context?.agent
        return agent === undefined || agent === null ? '' : guidanceText(agent)
      },
    })
  }

  ctx.tools.register({
    name: 'archive_outputs',
    description: '把本次对话在工作区根目录生成的文件归拢进本次对话的 `<日期>_<主题>` 文件夹，返回每个文件的新路径。交付文件本来就该写在那个文件夹里；本工具用于收拾漏在根目录的产物，或在还没建文件夹时用 `topic` 指定一个简短主题让它来建。',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: '要归拢的根目录文件路径（相对或绝对）。省略时归拢本次对话在根目录新生成的全部文件。',
          items: { type: 'string' },
        },
        topic: {
          type: 'string',
          description: `本次对话产物文件夹的主题，不超过 ${opts.topicMaxChars} 个字，如 \`题库转换\`。仅在该对话还没有产物文件夹时生效。`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          folder: { type: 'string' },
          moved: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
          userFiles: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                action: { type: 'string', enum: ['move', 'copy'] },
              },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, reason: { type: 'string' } },
              required: ['path', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['folder', 'moved', 'skipped'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const moved = Array.isArray(value?.moved) ? value.moved : []
        const userFiles = Array.isArray(value?.userFiles) ? value.userFiles : []
        const skipped = Array.isArray(value?.skipped) ? value.skipped : []
        const lines = [`产物目录：${value?.folder ?? ''}`]
        if (moved.length === 0 && userFiles.length === 0) lines.push('没有移动或复制任何文件。')
        if (moved.length > 0) {
          lines.push(`已归拢 ${moved.length} 个文件：`)
          for (const entry of moved) lines.push(`- ${entry.from} → ${entry.to}`)
        }
        if (userFiles.length > 0) {
          lines.push(`已处理用户提供的 ${userFiles.length} 个文件：`)
          for (const entry of userFiles) lines.push(`- ${entry.from} → ${entry.to}（${entry.action === 'copy' ? '复制' : '移动'}）`)
        }
        if (skipped.length > 0) {
          lines.push('未处理：')
          for (const entry of skipped) lines.push(`- ${entry.path}：${entry.reason}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec?.agent
      if (agent === undefined || agent === null) {
        return { folder: '', moved: [], userFiles: [], skipped: [{ path: '*', reason: '没有可用的会话上下文' }] }
      }
      if (!opts.enabled) {
        return { folder: '', moved: [], userFiles: [], skipped: [{ path: '*', reason: '插件已停用' }] }
      }
      return sweep(agent, { paths: args?.paths, topic: args?.topic })
    },
  })

  ctx.on('agent/created', async ({ agent }) => {
    if (!opts.enabled || !participates(agent)) return
    try {
      const state = stateOf(agent)
      state.dirty = false
      seedAttachments(agent.session)
      const baseline = await ensureBaseline(agent, state)
      if (baseline.names === null) warn(`记录目录基线失败：${baseline.reason}`)
    } catch (error) {
      warn(`记录目录基线失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('tools/result', exec => {
    if (!opts.enabled) return
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null || !participates(agent)) return
      const state = stateOf(agent)
      // Any tool ran, so this turn may have produced output in the root.
      state.dirty = true
      // Ownership only follows tools that can create files; a read of another
      // conversation's folder must not claim it.
      const name = typeof exec.name === 'string' ? exec.name : ''
      if (!WRITER_TOOL.test(name)) return
      const base = baseDirOf(agent)
      for (const raw of pathValues(exec.arguments)) {
        const relativePath = relative(base, isAbsolute(raw) ? raw : resolve(base, raw))
        if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) continue
        state.writes.add(relativePath.split(sep).join('/'))
        if (state.writes.size > 200) {
          const oldest = state.writes.values().next().value
          if (oldest !== undefined) state.writes.delete(oldest)
        }
      }
      for (const name of mentionedFolders(exec.arguments)) {
        state.mentions.add(name)
        if (state.mentions.size > 50) {
          const oldest = state.mentions.values().next().value
          if (oldest !== undefined) state.mentions.delete(oldest)
        }
      }
    } catch {
      /* tracking a write is best effort; it must never disturb the tool result */
    }
  })

  /**
   * Remember the attachments of one user message, once each.
   * @param session - the conversation the message belongs to.
   * @param message - the `user/message` payload.
   */
  function recordAttachments(session, message) {
    const found = attachmentsIn(message, opts.includeUserImages)
    if (found.length === 0) return
    let recorded = sessionAttachments.get(session.id)
    if (recorded === undefined) {
      recorded = new Map()
      sessionAttachments.set(session.id, recorded)
      if (sessionAttachments.size > 256) {
        const oldest = sessionAttachments.keys().next().value
        if (oldest !== undefined) sessionAttachments.delete(oldest)
      }
    }
    for (const item of found) {
      const id = String(item.ref?.attachmentId ?? '')
      if (id.length === 0 || recorded.has(id)) continue
      recorded.set(id, { ...item, done: false })
      if (recorded.size > 50) {
        const oldest = recorded.keys().next().value
        if (oldest !== undefined) recorded.delete(oldest)
      }
    }
  }

  /**
   * Re-read the attachments already in the session log, so a conversation
   * resumed or a plugin reloaded mid-way still gets its files archived.
   * @param session - the session to scan.
   */
  function seedAttachments(session) {
    if (!opts.includeUserFiles) return
    const events = session.snapshotEvents?.() ?? []
    for (const event of events) {
      if (event?.type === 'user/message') recordAttachments(session, event.data)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (!opts.enabled || !opts.includeUserFiles) return
    if (event?.type !== 'user/message') return
    try {
      recordAttachments(session, event.data)
    } catch {
      /* attachment tracking is best effort */
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!opts.enabled || !opts.autoArchive || !participates(agent)) return
    try {
      await sweep(agent)
    } catch (error) {
      warn(`回合结束归拢失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
