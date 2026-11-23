// NVM Manager worker. Runs in Orca's separate Node process (trusted-worker).
// nvm is a shell function, not a program, so every call goes through one fixed
// bash script that sources nvm.sh and runs `nvm "$@"`. The panel never builds a
// command line: it asks for an action by name and this worker turns it into a
// fixed argument list, passed to bash as positional parameters (never parsed).
import { spawn } from 'node:child_process'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

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

  // Find NVM_DIR and nvm.sh. Homebrew keeps nvm.sh outside NVM_DIR.
  async function locate() {
    if (process.platform === 'win32') {
      throw fail('unavailable', 'NVM Manager supports nvm on macOS and Linux. nvm-windows is a different tool.')
    }
    const { nvmDir } = await readSettings()
    const home = homedir()
    let dir = (typeof nvmDir === 'string' && nvmDir.trim()) || process.env.NVM_DIR || path.join(home, '.nvm')
    if (dir.startsWith('~')) dir = path.join(home, dir.slice(1))
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

  async function spawnNvm(script, args, { cwd, onLine, timeoutMs = 60_000 } = {}) {
    const { dir, sh } = await locate()
    const env = { ...process.env, NVM_DIR: dir, NVM_SH: sh, NO_COLOR: '1', TERM: 'dumb' }
    // nvm refuses to work while these are set (e.g. when Orca was started from npm).
    delete env.npm_config_prefix
    delete env.PREFIX
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(BASH, ['-c', script, 'nvm', ...args], { cwd: cwd ?? homedir(), env })
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
        resolve({ code, stdout, stderr, dir })
      })
    })
  }

  async function installedVersions() {
    const { dir } = await locate()
    try {
      return (await readdir(path.join(dir, 'versions', 'node'))).filter((n) => VERSION_RE.test(n)).sort(semverDesc)
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
    let lines
    try {
      const { code, stdout, stderr } = await spawnNvm(STATUS, pin && PIN_RE.test(pin) ? [pin] : [], { cwd: local ?? undefined })
      if (code !== 0) throw new Error((stderr || stdout).trim() || `nvm exited with ${code}`)
      lines = stdout.trim().split('\n').map((s) => s.trim())
    } catch (error) {
      return { ok: false, error: error.message, workspace }
    }
    const resolved = lines[2] && lines[2] !== 'N/A' ? lines[2] : null
    return {
      ok: true,
      nvmVersion: lines[0] || null,
      defaultVersion: lines[1] && lines[1] !== 'N/A' ? lines[1] : null,
      workspace,
      project: local ? { hasConfig: pin !== undefined, pinned: pin ?? null, resolved } : null,
      installed: await installedVersions(),
      activeJob: activeJob ? jobView(activeJob) : null
    }
  })

  // One row per major line (newest patch), newest first. nvm has no release dates.
  orca.panels.handle('nvm.releases', async ({ channel = 'lts', limit = 30 } = {}) => {
    if (!CHANNELS.has(channel)) throw fail('invalid_params', 'channel must be lts or all')
    const n = Math.max(1, Math.min(100, Number(limit) || 30))
    const args = ['ls-remote', '--no-colors']
    if (channel === 'lts') args.push('--lts')
    const { code, stdout, stderr } = await spawnNvm(RUN, args)
    if (code !== 0) throw fail('action_failed', (stderr || stdout).trim().split('\n').slice(-3).join(' ') || 'nvm ls-remote failed')
    const byMajor = new Map()
    for (const line of stdout.split('\n')) {
      const m = line.match(/(v\d+\.\d+\.\d+)(?:.*\((?:Latest )?LTS: ([^)]+)\))?/)
      if (!m) continue
      const major = m[1].split('.')[0]
      const prev = byMajor.get(major)
      if (!prev || semverDesc(m[1], prev.version) < 0) byMajor.set(major, { version: m[1], lts: m[2] ?? null })
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
      return (await spawnNvm(RUN, args, { onLine, timeoutMs: 45 * 60_000 })).code
    }

    async function work() {
      if (action === 'install') return nvm(['install', version])
      if (action === 'uninstall') return nvm(['uninstall', version])
      if (action === 'default') return nvm(['alias', 'default', version])
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
