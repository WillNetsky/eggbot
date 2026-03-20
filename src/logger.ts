import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const LOG_DIR = join(homedir(), '.eggbot', 'logs')
await mkdir(LOG_DIR, { recursive: true })

const LOG_FILE = join(LOG_DIR, 'eggbot.log')

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

type LogListener = (entry: LogEntry) => void

export interface LogEntry {
  ts: number
  level: LogLevel
  msg: string
  data?: unknown
}

const listeners = new Set<LogListener>()

function write(level: LogLevel, msg: string, data?: unknown) {
  const entry: LogEntry = { ts: Date.now(), level, msg, data }

  // File
  const line = `[${new Date(entry.ts).toISOString()}] [${level.toUpperCase()}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}\n`
  appendFile(LOG_FILE, line).catch(() => {})

  // Broadcast to any attached listeners (WebSocket clients)
  for (const fn of listeners) fn(entry)
}

export const log = {
  info:  (msg: string, data?: unknown) => write('info',  msg, data),
  warn:  (msg: string, data?: unknown) => write('warn',  msg, data),
  error: (msg: string, data?: unknown) => write('error', msg, data),
  debug: (msg: string, data?: unknown) => write('debug', msg, data),
  onLog: (fn: LogListener) => { listeners.add(fn); return () => listeners.delete(fn) },
}

export default log
