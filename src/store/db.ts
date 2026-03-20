import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = join(homedir(), '.eggbot')
mkdirSync(dataDir, { recursive: true })

const db = new Database(join(dataDir, 'eggbot.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    agent_id TEXT,
    agent_name TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
`)

export interface DbSession {
  id: string
  created_at: number
  updated_at: number
  title: string | null
}

export interface DbMessage {
  id: string
  session_id: string
  role: string
  content: string
  agent_id: string | null
  agent_name: string | null
  metadata: string | null
  created_at: number
}

export interface DbAgentRun {
  id: string
  session_id: string
  parent_id: string | null
  name: string
  model: string
  status: string
  created_at: number
  completed_at: number | null
}

export const sessions = {
  create(id: string, title?: string): DbSession {
    const now = Date.now()
    db.prepare('INSERT INTO sessions (id, created_at, updated_at, title) VALUES (?, ?, ?, ?)').run(id, now, now, title ?? null)
    return { id, created_at: now, updated_at: now, title: title ?? null }
  },
  get(id: string): DbSession | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSession | undefined
  },
  list(): DbSession[] {
    return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50').all() as DbSession[]
  },
  updateTitle(id: string, title: string) {
    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id)
  },
  touch(id: string) {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  },
}

export const messages = {
  insert(msg: Omit<DbMessage, 'created_at'>): DbMessage {
    const created_at = Date.now()
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, agent_id, agent_name, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(msg.id, msg.session_id, msg.role, msg.content, msg.agent_id ?? null, msg.agent_name ?? null, msg.metadata ?? null, created_at)
    return { ...msg, created_at }
  },
  list(session_id: string): DbMessage[] {
    return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(session_id) as DbMessage[]
  },
}

export const agentRuns = {
  insert(run: Omit<DbAgentRun, 'completed_at'>): DbAgentRun {
    db.prepare(
      'INSERT INTO agent_runs (id, session_id, parent_id, name, model, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(run.id, run.session_id, run.parent_id ?? null, run.name, run.model, run.status, run.created_at)
    return { ...run, completed_at: null }
  },
  complete(id: string, status: 'done' | 'error') {
    db.prepare('UPDATE agent_runs SET status = ?, completed_at = ? WHERE id = ?').run(status, Date.now(), id)
  },
  list(session_id: string): DbAgentRun[] {
    return db.prepare('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC').all(session_id) as DbAgentRun[]
  },
}

export default db
