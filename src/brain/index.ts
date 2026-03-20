/**
 * eggbot brain — Obsidian-style markdown vault at ~/.eggbot/brain/
 *
 * Notes are plain .md files with YAML frontmatter.
 * A SQLite FTS5 index enables fast full-text and tag search.
 * Relevant notes are injected into agent context automatically.
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname, relative, extname, basename } from 'path'
import { homedir } from 'os'
import Database from 'better-sqlite3'

export const BRAIN_DIR = join(homedir(), '.eggbot', 'brain')
const INDEX_DB = join(homedir(), '.eggbot', 'brain-index.db')

// ── Init ─────────────────────────────────────────────────────────────────────

await mkdir(BRAIN_DIR, { recursive: true })
await mkdir(join(BRAIN_DIR, 'daily'), { recursive: true })
await mkdir(join(BRAIN_DIR, 'people'), { recursive: true })
await mkdir(join(BRAIN_DIR, 'projects'), { recursive: true })
await mkdir(join(BRAIN_DIR, 'knowledge'), { recursive: true })

const idx = new Database(INDEX_DB)

idx.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED,
    title,
    content,
    tags,
    tokenize = 'porter ascii'
  );
  CREATE TABLE IF NOT EXISTS notes_meta (
    path TEXT PRIMARY KEY,
    title TEXT,
    tags TEXT,
    links TEXT,
    created TEXT,
    updated TEXT,
    pinned INTEGER DEFAULT 0
  );
`)

// ── Frontmatter parsing ───────────────────────────────────────────────────────

export interface NoteMeta {
  title: string
  tags: string[]
  links: string[]
  created: string
  updated: string
  pinned?: boolean
}

export interface Note {
  path: string       // relative to BRAIN_DIR, e.g. "people/will.md"
  meta: NoteMeta
  body: string       // content without frontmatter
  raw: string        // full file content
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseFrontmatter(raw: string): { meta: Partial<NoteMeta>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw }

  const fmText = match[1]
  const body = match[2]
  const meta: Partial<NoteMeta> = {}

  for (const line of fmText.split('\n')) {
    const [key, ...rest] = line.split(':')
    if (!key || !rest.length) continue
    const val = rest.join(':').trim()

    if (key.trim() === 'title') meta.title = val
    else if (key.trim() === 'created') meta.created = val
    else if (key.trim() === 'updated') meta.updated = val
    else if (key.trim() === 'pinned') meta.pinned = val === 'true'
    else if (key.trim() === 'tags') {
      meta.tags = val.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean)
    } else if (key.trim() === 'links') {
      meta.links = val.replace(/[\[\]]/g, '').split(',').map(l => l.trim()).filter(Boolean)
    }
  }

  return { meta, body }
}

function serializeFrontmatter(meta: NoteMeta, body: string): string {
  const tags = meta.tags.length ? `[${meta.tags.join(', ')}]` : '[]'
  const links = meta.links.length ? `[${meta.links.join(', ')}]` : '[]'
  const pinned = meta.pinned ? '\npinned: true' : ''
  return `---
title: ${meta.title}
tags: ${tags}
links: ${links}
created: ${meta.created}
updated: ${meta.updated}${pinned}
---

${body.trim()}
`
}

// ── Core operations ───────────────────────────────────────────────────────────

export async function writeNote(
  path: string,
  body: string,
  metaOverrides: Partial<NoteMeta> = {}
): Promise<Note> {
  const absPath = join(BRAIN_DIR, path)
  await mkdir(dirname(absPath), { recursive: true })

  let existingMeta: Partial<NoteMeta> = {}
  if (existsSync(absPath)) {
    const raw = await readFile(absPath, 'utf-8')
    existingMeta = parseFrontmatter(raw).meta
  }

  const filename = basename(path, extname(path))
  const meta: NoteMeta = {
    title: metaOverrides.title ?? existingMeta.title ?? filename,
    tags: metaOverrides.tags ?? existingMeta.tags ?? [],
    links: metaOverrides.links ?? existingMeta.links ?? [],
    created: existingMeta.created ?? today(),
    updated: today(),
    pinned: metaOverrides.pinned ?? existingMeta.pinned ?? false,
  }

  // Extract [[wikilinks]] from body and add to links
  const wikilinks = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1])
  for (const link of wikilinks) {
    if (!meta.links.includes(link)) meta.links.push(link)
  }

  const raw = serializeFrontmatter(meta, body)
  await writeFile(absPath, raw, 'utf-8')
  indexNote(path, meta, body)

  return { path, meta, body, raw }
}

export async function readNote(path: string): Promise<Note | null> {
  const absPath = join(BRAIN_DIR, path)
  if (!existsSync(absPath)) return null

  const raw = await readFile(absPath, 'utf-8')
  const { meta: partial, body } = parseFrontmatter(raw)
  const filename = basename(path, extname(path))

  const meta: NoteMeta = {
    title: partial.title ?? filename,
    tags: partial.tags ?? [],
    links: partial.links ?? [],
    created: partial.created ?? today(),
    updated: partial.updated ?? today(),
    pinned: partial.pinned ?? false,
  }

  return { path, meta, body, raw }
}

export function searchNotes(query: string, limit = 8): Array<{ path: string; title: string; snippet: string; tags: string[] }> {
  try {
    const rows = idx.prepare(`
      SELECT path, title, snippet(notes_fts, 2, '[', ']', '...', 20) as snippet, tags
      FROM notes_fts
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Array<{ path: string; title: string; snippet: string; tags: string }>

    return rows.map(r => ({
      path: r.path,
      title: r.title,
      snippet: r.snippet,
      tags: r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    }))
  } catch {
    return []
  }
}

export function searchByTag(tag: string): Array<{ path: string; title: string }> {
  const rows = idx.prepare(`
    SELECT path, title FROM notes_meta
    WHERE tags LIKE ?
  `).all(`%${tag}%`) as Array<{ path: string; title: string }>
  return rows
}

export async function listNotes(folder?: string): Promise<Array<{ path: string; title: string; tags: string[]; updated: string }>> {
  const results: Array<{ path: string; title: string; tags: string[]; updated: string }> = []
  const root = folder ? join(BRAIN_DIR, folder) : BRAIN_DIR
  await walkDir(root, async (absPath) => {
    if (!absPath.endsWith('.md')) return
    const relPath = relative(BRAIN_DIR, absPath)
    const note = await readNote(relPath)
    if (note) {
      results.push({ path: relPath, title: note.meta.title, tags: note.meta.tags, updated: note.meta.updated })
    }
  })
  return results.sort((a, b) => b.updated.localeCompare(a.updated))
}

export async function getDailyNote(): Promise<Note> {
  const date = today()
  const path = `daily/${date}.md`
  const existing = await readNote(path)
  if (existing) return existing

  return writeNote(path, `# ${date}\n\n`, {
    title: date,
    tags: ['daily'],
  })
}

export async function appendToDailyNote(content: string): Promise<Note> {
  const note = await getDailyNote()
  const newBody = note.body.trimEnd() + '\n\n' + content.trim() + '\n'
  return writeNote(note.path, newBody, { title: note.meta.title, tags: note.meta.tags })
}

export function getPinnedNotes(): Array<{ path: string; title: string }> {
  return idx.prepare(`SELECT path, title FROM notes_meta WHERE pinned = 1`).all() as Array<{ path: string; title: string }>
}

// ── Index management ──────────────────────────────────────────────────────────

function indexNote(path: string, meta: NoteMeta, body: string) {
  const tags = meta.tags.join(', ')
  const links = meta.links.join(', ')

  idx.prepare(`DELETE FROM notes_fts WHERE path = ?`).run(path)
  idx.prepare(`INSERT INTO notes_fts (path, title, content, tags) VALUES (?, ?, ?, ?)`).run(path, meta.title, body, tags)

  idx.prepare(`
    INSERT OR REPLACE INTO notes_meta (path, title, tags, links, created, updated, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(path, meta.title, tags, links, meta.created, meta.updated, meta.pinned ? 1 : 0)
}

async function walkDir(dir: string, fn: (path: string) => Promise<void>) {
  if (!existsSync(dir)) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkDir(full, fn)
    else await fn(full)
  }
}

// Re-index all notes on startup
export async function reindex() {
  idx.prepare(`DELETE FROM notes_fts`).run()
  idx.prepare(`DELETE FROM notes_meta`).run()
  await walkDir(BRAIN_DIR, async (absPath) => {
    if (!absPath.endsWith('.md')) return
    const relPath = relative(BRAIN_DIR, absPath)
    const note = await readNote(relPath)
    if (note) indexNote(relPath, note.meta, note.body)
  })
}

await reindex()

// ── Context builder ───────────────────────────────────────────────────────────

/**
 * Build brain context to inject into agent system prompt.
 * Pulls pinned notes + today's daily + notes relevant to the query.
 */
export async function buildContext(query?: string): Promise<string> {
  const parts: string[] = ['## Brain\n']

  // Pinned notes
  const pinned = getPinnedNotes()
  if (pinned.length) {
    parts.push('### Pinned\n')
    for (const p of pinned) {
      const note = await readNote(p.path)
      if (note) parts.push(`**${note.meta.title}** (${p.path})\n${note.body.trim()}\n`)
    }
  }

  // Today's daily note
  const daily = await getDailyNote()
  if (daily.body.trim() && daily.body.trim() !== `# ${daily.meta.title}`) {
    parts.push(`### Today (${daily.meta.title})\n${daily.body.trim()}\n`)
  }

  // Relevant notes from search
  if (query) {
    const results = searchNotes(query, 5)
    const relevant = results.filter(r => r.path !== daily.path)
    if (relevant.length) {
      parts.push('### Relevant notes\n')
      for (const r of relevant) {
        parts.push(`**${r.title}** (${r.path}): ${r.snippet}\n`)
      }
    }
  }

  return parts.length > 1 ? parts.join('\n') : ''
}
