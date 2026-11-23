// NVM Manager worker. Runs in Orca's separate Node process (trusted-worker).
// macOS/Linux: nvm is a shell function, so every call goes through one fixed
// bash script that sources nvm.sh and runs `nvm "$@"`.
// Windows: nvm-windows is a program (nvm.exe), started directly without a shell.
// The panel never builds a command line: it asks for an action by name and this
// worker turns it into a fixed argument list that is never parsed by a shell.
import { spawn } from 'node:child_process'
import { access, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const IS_WIN = process.platform === 'win32'
const VERSION_RE = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/
const PIN_RE = /^[A-Za-z0-9][A-Za-z0-9._/*-]{0,49}$/ // what .nvmrc may hold: 22, lts/jod, node, v22.1.0
const CHANNELS = new Set(['lts', 'all'])
const ACTIONS = new Set(['pin', 'install', 'uninstall', 'default'])
const MAX_LOG_LINES = 300
const BASH = '/bin/bash'
const RUN = '. "$NVM_SH" --no-use >/dev/null 2>&1 || { echo "Could not load $NVM_SH" >&2; exit 127; }\nnvm "$@"'
const STATUS = '. "$NVM_SH" --no-use >/dev/null 2>&1 || exit 127\nnvm --version\nnvm version default\nif [ -n "$1" ]; then nvm version "$1"; fi\ntrue'

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g
const clean = (s) => s.replace(ANSI_RE, '').replace(/\r/g, '')
const exists = (p) => access(p).then(() => true, () => false)
const semverDesc = (a, b) => {
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2]
}

// Resolve an .nvmrc value like "22", "v22.1" or "22.1.0" against installed
// versions (newest first). Aliases such as lts/jod need nvm itself.
export function resolvePin(pin, installed) {
  const want = pin.replace(/^v/, '').split('.')
  if (!want.every((p) => /^\d+$/.test(p))) return null
  return installed.find((v) => want.every((p, i) => v.slice(1).split('.')[i] === p)) ?? null
}

// Parse `nvm list available` (nvm-windows): a table whose columns are
// CURRENT | LTS | OLD STABLE | OLD UNSTABLE. Only the first two are useful.
export function parseWindowsAvailable(stdout, channel) {
  const out = []
  for (const line of stdout.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const [current, lts] = [cells[1], cells[2]]
    if (/^\d+\.\d+\.\d+$/.test(lts)) out.push({ version: `v${lts}`, label: 'LTS' })
    if (channel === 'all' && /^\d+\.\d+\.\d+$/.test(current)) out.push({ version: `v${current}`, label: 'Current' })
  }
  return out
}

export default function activate(orca) {
  const jobs = new Map()
  let jobCounter = 0
  let activeJob = null

  async function readSettings() {
    try {
      const { settings } = await orca.host.call('settings.get', {})
      return settings ?? {}
    } catch {
      return {}
    }
  }

  // Unix: NVM_DIR + nvm.sh (Homebrew keeps nvm.sh outside NVM_DIR).
  // Windows: NVM_HOME + nvm.exe.
  async function locate() {
    const { nvmDir } = await readSettings()
    const home = homedir()
    let dir = typeof nvmDir === 'string' && nvmDir.trim()
    if (dir && dir.startsWith('~')) dir = path.join(home, dir.slice(1))
    if (IS_WIN) {
      dir = dir || process.env.NVM_HOME || path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'nvm')
      const exe = path.join(dir, 'nvm.exe')
      if (await exists(exe)) return { dir, exe }
      throw fail('unavailable', `Can't find nvm.exe (looked in ${dir}). Install nvm-windows or set the NVM directory in the plugin settings.`)
    }
    dir = dir || process.env.NVM_DIR || path.join(home, '.nvm')
    const candidates = [
      path.join(dir, 'nvm.sh'),
      '/opt/homebrew/opt/nvm/nvm.sh',
      '/usr/local/opt/nvm/nvm.sh',
      '/home/linuxbrew/.linuxbrew/opt/nvm/nvm.sh',
      '/usr/share/nvm/nvm.sh'
    ]
    for (const sh of candidates) if (await exists(sh)) return { dir, sh }
    throw fail('unavailable', `Can't find nvm.sh (looked in ${dir}). Install nvm or set the NVM directory in the plugin settings.`)
  }

  // Run nvm with a fixed argument list. `script` is only used on macOS/Linux.
  async function spawnNvm(args, { script = RUN, cwd, onLine, timeoutMs = 60_000 } = {}) {
    const loc = await locate()
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
    let file, argv
    if (IS_WIN) {
      file = loc.exe
      argv = args.map((a) => (VERSION_RE.test(a) ? a.slice(1) : a)) // nvm-windows wants 22.1.0
      env.NVM_HOME = loc.dir
    } else {
      file = BASH
      argv = ['-c', script, 'nvm', ...args]
      Object.assign(env, { NVM_DIR: loc.dir, NVM_SH: loc.sh })
      // nvm refuses to work while these are set (e.g. when Orca was started from npm).
      delete env.npm_config_prefix
      delete env.PREFIX
    }
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(file, argv, { cwd: cwd ?? homedir(), env, windowsHide: true })
      } catch (error) {
        reject(error)
        return
      }
      let stdout = ''
      let stderr = ''
      let pending = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      const feed = (chunk, isErr) => {
        const text = clean(chunk.toString())
        if (isErr) stderr += text
        else stdout += text
        if (!onLine) return
        pending += text
        const lines = pending.split('\n')
        pending = lines.pop()
        for (const line of lines) if (line.trim()) onLine(line)
      }
      child.stdout.on('data', (c) => feed(c, false))
      child.stderr.on('data', (c) => feed(c, true))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (onLine && pending.trim()) onLine(pending)
        resolve({ code, stdout, stderr })
      })
    })
  }

  async function installedVersions() {
    const { dir } = await locate()
    try {
      const root = IS_WIN ? dir : path.join(dir, 'versions', 'node')
      return (await readdir(root)).filter((n) => VERSION_RE.test(n)).sort(semverDesc)
    } catch {
      return []
    }
  }

  async function readPin(dir) {
    try {
      const line = (await readFile(path.join(dir, '.nvmrc'), 'utf8')).split('\n')[0].trim()
      return line || null
    } catch {
      return undefined // no .nvmrc
    }
  }

  // Returns [nvmVersion, defaultVersion, resolvedPin].
  async function nvmInfo(pin, cwd, installed) {
    if (IS_WIN) {
      const { code, stdout, stderr } = await spawnNvm(['version'])
      if (code !== 0) throw new Error((stderr || stdout).trim() || `nvm exited with ${code}`)
      // nvm-windows has no default alias; the active version is where NVM_SYMLINK points.
      let active = null
      try {
        const link = process.env.NVM_SYMLINK || path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')
        const name = path.basename(await realpath(link))
        if (VERSION_RE.test(name)) active = name
      } catch {}
      return [stdout.trim().split('\n')[0].trim(), active, pin ? resolvePin(pin, installed) : null]
    }
    const { code, stdout, stderr } = await spawnNvm(pin ? [pin] : [], { script: STATUS, cwd })
    if (code !== 0) throw new Error((stderr || stdout).trim() || `nvm exited with ${code}`)
    const lines = stdout.trim().split('\n').map((s) => s.trim())
    const na = (s) => (s && s !== 'N/A' ? s : null)
    return [lines[0] || null, na(lines[1]), na(lines[2])]
  }

  async function focusedWorkspace() {
    const ctx = await orca.host.call('workspace.readContext', {})
    if (!ctx) return null
    const { workspaces } = await orca.host.call('workspace.list', {})
    const row =
      workspaces.find((w) => ctx.workspaceId && w.id === ctx.workspaceId) ??
      workspaces.find((w) => w.name === ctx.displayName && w.branch === ctx.branch)
    if (!row) return { name: ctx.displayName, branch: ctx.branch, path: null, remote: false }
    const remote = row.hostId != null && row.hostId !== 'local'
    return { name: row.name, branch: row.branch, path: row.path, remote }
  }

  function jobView(job) {
    const { id, action, version, state, exitCode, startedAt, endedAt, log } = job
    return { id, action, version, state, exitCode, startedAt, endedAt, log: log.slice(-80) }
  }

  orca.panels.handle('nvm.status', async () => {
    const workspace = await focusedWorkspace().catch(() => null)
    const local = workspace?.path && !workspace.remote ? workspace.path : null
    const pin = local ? await readPin(local) : undefined
    let info, installed
    try {
      installed = await installedVersions()
      info = await nvmInfo(pin && PIN_RE.test(pin) ? pin : null, local ?? undefined, installed)
    } catch (error) {
      return { ok: false, error: error.message, workspace }
    }
    const [nvmVersion, defaultVersion, resolved] = info
    return {
      ok: true,
      platform: process.platform,
      nvmVersion,
      defaultVersion,
      workspace,
      project: local ? { hasConfig: pin !== undefined, pinned: pin ?? null, resolved } : null,
      installed,
      activeJob: activeJob ? jobView(activeJob) : null
    }
  })

  // One row per major line (newest patch), newest first. nvm has no release dates.
  orca.panels.handle('nvm.releases', async ({ channel = 'lts', limit = 30 } = {}) => {
    if (!CHANNELS.has(channel)) throw fail('invalid_params', 'channel must be lts or all')
    const n = Math.max(1, Math.min(100, Number(limit) || 30))
    const args = IS_WIN ? ['list', 'available'] : ['ls-remote', '--no-colors', ...(channel === 'lts' ? ['--lts'] : [])]
    const { code, stdout, stderr } = await spawnNvm(args)
    if (code !== 0) throw fail('action_failed', (stderr || stdout).trim().split('\n').slice(-3).join(' ') || `nvm ${args.join(' ')} failed`)
    let rows
    if (IS_WIN) {
      rows = parseWindowsAvailable(stdout, channel)
    } else {
      rows = []
      for (const line of stdout.split('\n')) {
        const m = line.match(/(v\d+\.\d+\.\d+)(?:.*\((?:Latest )?LTS: ([^)]+)\))?/)
        if (m) rows.push({ version: m[1], label: m[2] ? `LTS ${m[2]}` : 'Current' })
      }
    }
    const byMajor = new Map()
    for (const r of rows) {
      const major = r.version.split('.')[0]
      const prev = byMajor.get(major)
      if (!prev || semverDesc(r.version, prev.version) < 0) byMajor.set(major, r)
    }
    return [...byMajor.values()].sort((a, b) => semverDesc(a.version, b.version)).slice(0, n)
  })

  orca.panels.handle('nvm.run', async ({ action, version } = {}) => {
    if (!ACTIONS.has(action)) throw fail('invalid_params', `Unknown action "${action}"`)
    if (typeof version !== 'string' || !VERSION_RE.test(version)) {
      throw fail('invalid_params', 'That is not a valid Node.js version (expected vX.Y.Z).')
    }
    if (activeJob) throw fail('conflict', `${activeJob.action} ${activeJob.version} is still running.`)

    let ws
    if (action === 'pin') {
      ws = await focusedWorkspace()
      if (!ws?.path) throw fail('invalid_params', 'Focus a workspace in Orca first.')
      if (ws.remote) throw fail('invalid_params', 'This workspace is on a remote host; NVM Manager only changes this computer.')
    }

    const job = {
      id: `job-${++jobCounter}`,
      action,
      version,
      state: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      log: []
    }
    jobs.set(job.id, job)
    activeJob = job

    // Batch output so a chatty install stays well inside Orca's post budget.
    let buffered = []
    const flush = () => {
      if (!buffered.length) return
      orca.panels.post('nvm.job.output', { id: job.id, lines: buffered })
      buffered = []
    }
    const ticker = setInterval(flush, 500)
    const onLine = (line) => {
      job.log.push(line)
      if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES)
      buffered.push(line)
    }
    const nvm = async (args) => {
      onLine(`$ nvm ${args.join(' ')}`)
      return (await spawnNvm(args, { onLine, timeoutMs: 45 * 60_000 })).code
    }

    async function work() {
      if (action === 'install') return nvm(['install', version])
      if (action === 'uninstall') return nvm(['uninstall', version])
      // nvm-windows has no default alias: `nvm use` switches the system-wide version.
      if (action === 'default') return nvm(IS_WIN ? ['use', version] : ['alias', 'default', version])
      // pin: write .nvmrc, then install it if asked and missing.
      await writeFile(path.join(ws.path, '.nvmrc'), `${version}\n`)
      onLine(`Wrote ${version} to ${path.join(ws.path, '.nvmrc')}`)
      const { installAfterPin = true } = await readSettings()
      if (installAfterPin && !(await installedVersions()).includes(version)) return nvm(['install', version])
      return 0
    }

    orca.panels.post('nvm.job.started', jobView(job))
    work()
      .then((code) => {
        job.exitCode = code
        job.state = code === 0 ? 'done' : 'failed'
      })
      .catch((error) => {
        onLine(error.message)
        job.state = 'failed'
      })
      .finally(async () => {
        clearInterval(ticker)
        flush()
        job.endedAt = Date.now()
        activeJob = null
        orca.panels.post('nvm.job.finished', jobView(job))
        orca.log(`nvm ${action} ${version}: ${job.state}`)
        try {
          await orca.host.call('notifications.show', {
            title: job.state === 'done' ? `${action} ${version} finished` : `${action} ${version} failed`,
            body: job.log[job.log.length - 1] ?? ''
          })
        } catch {}
      })

    return { jobId: job.id }
  })

  orca.panels.handle('nvm.job', async ({ id } = {}) => {
    const job = jobs.get(id)
    if (!job) throw fail('invalid_params', 'No such job')
    return jobView(job)
  })
}
