import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = join(homedir(), '.eggbot')
mkdirSync(dataDir, { recursive: true })

const db = new Database(join(dataDir, 'eggbot.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    priority INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title TEXT,
    type TEXT NOT NULL DEFAULT 'user',
    goal_ref TEXT
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
  type: 'user' | 'heartbeat' | 'goal'
  goal_ref: string | null
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

// Migrate existing databases that predate type/goal_ref columns
try { db.exec(`ALTER TABLE sessions ADD COLUMN type TEXT NOT NULL DEFAULT 'user'`) } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN goal_ref TEXT`) } catch {}

export const sessions = {
  create(id: string, title?: string, type: DbSession['type'] = 'user', goalRef?: string): DbSession {
    const now = Date.now()
    db.prepare('INSERT INTO sessions (id, created_at, updated_at, title, type, goal_ref) VALUES (?, ?, ?, ?, ?, ?)').run(id, now, now, title ?? null, type, goalRef ?? null)
    return { id, created_at: now, updated_at: now, title: title ?? null, type, goal_ref: goalRef ?? null }
  },
  get(id: string): DbSession | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSession | undefined
  },
  list(): DbSession[] {
    return db.prepare("SELECT * FROM sessions WHERE type != 'heartbeat' ORDER BY updated_at DESC LIMIT 50").all() as DbSession[]
  },
  updateTitle(id: string, title: string) {
    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id)
  },
  touch(id: string) {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  },
  /** Find or create the single persistent heartbeat thread. */
  getOrCreateHeartbeat(): DbSession {
    const existing = db.prepare(`SELECT * FROM sessions WHERE type = 'heartbeat' LIMIT 1`).get() as DbSession | undefined
    if (existing) return existing
    return sessions.create(randomUUID(), 'Heartbeat', 'heartbeat')
  },
  /** Find or create a persistent thread for a specific goal (keyed by brain note path). */
  getOrCreateForGoal(goalRef: string, title: string): DbSession {
    const existing = db.prepare(`SELECT * FROM sessions WHERE goal_ref = ? LIMIT 1`).get(goalRef) as DbSession | undefined
    if (existing) return existing
    return sessions.create(randomUUID(), title, 'goal', goalRef)
  },
  /** Link a session to a brain goal note. */
  setGoalRef(id: string, goalRef: string) {
    db.prepare(`UPDATE sessions SET goal_ref = ?, type = 'goal', updated_at = ? WHERE id = ?`).run(goalRef, Date.now(), id)
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

export interface DbTodo {
  id: string
  title: string
  status: 'todo' | 'in_progress' | 'done'
  priority: number
  notes: string | null
  created_at: number
  updated_at: number
}

export const todos = {
  list(status?: DbTodo['status']): DbTodo[] {
    if (status) {
      return db.prepare('SELECT * FROM todos WHERE status = ? ORDER BY priority DESC, created_at ASC').all(status) as DbTodo[]
    }
    return db.prepare('SELECT * FROM todos ORDER BY priority DESC, created_at ASC').all() as DbTodo[]
  },
  create(id: string, title: string, priority = 0, notes?: string): DbTodo {
    const now = Date.now()
    db.prepare('INSERT INTO todos (id, title, status, priority, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, title, 'todo', priority, notes ?? null, now, now)
    return { id, title, status: 'todo', priority, notes: notes ?? null, created_at: now, updated_at: now }
  },
  update(id: string, fields: Partial<Pick<DbTodo, 'title' | 'status' | 'priority' | 'notes'>>): DbTodo | undefined {
    const now = Date.now()
    const sets: string[] = ['updated_at = ?']
    const vals: unknown[] = [now]
    if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title) }
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status) }
    if (fields.priority !== undefined) { sets.push('priority = ?'); vals.push(fields.priority) }
    if (fields.notes !== undefined) { sets.push('notes = ?'); vals.push(fields.notes) }
    vals.push(id)
    db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    return db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as DbTodo | undefined
  },
  delete(id: string) {
    db.prepare('DELETE FROM todos WHERE id = ?').run(id)
  },
}

export default db
