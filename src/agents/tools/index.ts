import { exec } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { Tool } from '../../llm/client.js'
import {
  writeNote, readNote, searchNotes, searchByTag, listNotes,
  getDailyNote, appendToDailyNote, BRAIN_DIR
} from '../../brain/index.js'
import log from '../../logger.js'

const execAsync = promisify(exec)

export interface ToolResult {
  success: boolean
  output: string
}

// Tool definitions for the LLM
export const TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command on the system. Use for any system operations, running programs, git, npm, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional, defaults to home)' },
          timeout: { type: 'string', description: 'Timeout in ms (optional, default 30000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file with given content. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at a path',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch content from a URL (web page, API, etc.)',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          body: { type: 'string', description: 'Request body for POST/PUT (optional)' },
          headers: { type: 'string', description: 'JSON string of headers (optional)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description: 'Spawn a sub-agent to handle a specific task in parallel. Returns immediately with an agent ID. Use this to delegate work.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short descriptive name for this agent (e.g. "file-researcher", "code-writer")' },
          task: { type: 'string', description: 'Full task description for the agent. Be specific and detailed.' },
          model: {
            type: 'string',
            description: 'Model to use: "orchestrator" (smart), "coder" (coding), "fast" (quick tasks), "reasoning" (complex logic)',
            enum: ['orchestrator', 'coder', 'fast', 'reasoning'],
          },
        },
        required: ['name', 'task', 'model'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_write',
      description: 'Write or update a note in the brain vault. Use [[wikilinks]] to link related notes. Path is relative to the vault, e.g. "people/will.md" or "projects/eggbot.md".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Note path relative to vault, e.g. "knowledge/typescript.md"' },
          content: { type: 'string', description: 'Markdown content of the note body (no frontmatter needed)' },
          title: { type: 'string', description: 'Note title (optional, defaults to filename)' },
          tags: { type: 'string', description: 'Comma-separated tags, e.g. "person, important"' },
          pinned: { type: 'string', description: 'Set to "true" to pin this note so it always appears in context' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_read',
      description: 'Read a note from the brain vault by its path',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Note path relative to vault, e.g. "people/will.md"' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_search',
      description: 'Full-text search across all brain notes. Use for finding relevant knowledge before answering.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          tag: { type: 'string', description: 'Filter by tag (optional)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_list',
      description: 'List notes in the brain vault, optionally filtered by folder',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Subfolder to list, e.g. "people", "projects", "daily", "knowledge". Omit for all.', enum: ['people', 'projects', 'daily', 'knowledge'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_daily',
      description: "Get today's daily note, or append an entry to it",
      parameters: {
        type: 'object',
        properties: {
          append: { type: 'string', description: 'Text to append to today\'s daily note (optional — omit to just read it)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_agents',
      description: 'Wait for one or more spawned agents to complete and get their results',
      parameters: {
        type: 'object',
        properties: {
          agent_ids: { type: 'string', description: 'Comma-separated list of agent IDs to wait for' },
        },
        required: ['agent_ids'],
      },
    },
  },
]

export async function executeTool(
  name: string,
  args: Record<string, string>,
  spawnAgent: (name: string, task: string, model: string) => Promise<string>,
  waitForAgents: (ids: string[]) => Promise<Record<string, string>>
): Promise<ToolResult> {
  log.debug(`[tool] ${name}`, args)
  try {
    switch (name) {
      case 'bash': {
        const cwd = args.cwd ?? homedir()
        const timeout = parseInt(args.timeout ?? '30000')
        const { stdout, stderr } = await execAsync(args.command, { cwd, timeout, shell: '/bin/zsh' })
        return { success: true, output: (stdout + stderr).trim() || '(no output)' }
      }

      case 'read_file': {
        const content = await readFile(args.path, 'utf-8')
        return { success: true, output: content }
      }

      case 'write_file': {
        await mkdir(dirname(args.path), { recursive: true })
        await writeFile(args.path, args.content, 'utf-8')
        return { success: true, output: `Written ${args.content.length} bytes to ${args.path}` }
      }

      case 'list_dir': {
        const entries = await readdir(args.path, { withFileTypes: true })
        const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
        return { success: true, output: lines.join('\n') || '(empty)' }
      }

      case 'fetch_url': {
        const method = args.method ?? 'GET'
        const headers: Record<string, string> = args.headers ? JSON.parse(args.headers) : {}
        const opts: RequestInit = { method, headers }
        if (args.body) opts.body = args.body

        const res = await fetch(args.url, opts)
        const text = await res.text()
        // Truncate very large responses
        const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text
        return { success: true, output: `HTTP ${res.status}\n${truncated}` }
      }

      case 'brain_write': {
        const tags = args.tags ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined
        const pinned = args.pinned === 'true'
        const note = await writeNote(args.path, args.content, {
          title: args.title,
          tags,
          pinned,
        })
        return { success: true, output: `Wrote note: ${note.path} (${note.meta.tags.join(', ') || 'no tags'})` }
      }

      case 'brain_read': {
        const note = await readNote(args.path)
        if (!note) return { success: false, output: `Note not found: ${args.path}` }
        return { success: true, output: `# ${note.meta.title}\ntags: ${note.meta.tags.join(', ')}\nlinks: ${note.meta.links.join(', ')}\n\n${note.body}` }
      }

      case 'brain_search': {
        if (args.tag) {
          const results = searchByTag(args.tag)
          if (!results.length) return { success: true, output: `No notes tagged "${args.tag}"` }
          return { success: true, output: results.map(r => `- ${r.title} (${r.path})`).join('\n') }
        }
        const results = searchNotes(args.query)
        if (!results.length) return { success: true, output: 'No matching notes found' }
        return {
          success: true,
          output: results.map(r => `**${r.title}** (${r.path})\n  ${r.snippet}`).join('\n\n'),
        }
      }

      case 'brain_list': {
        const notes = await listNotes(args.folder)
        if (!notes.length) return { success: true, output: 'No notes found' }
        return {
          success: true,
          output: notes.map(n => `- ${n.title} (${n.path}) [${n.tags.join(', ')}] — ${n.updated}`).join('\n'),
        }
      }

      case 'brain_daily': {
        if (args.append) {
          const note = await appendToDailyNote(args.append)
          return { success: true, output: `Appended to ${note.path}` }
        }
        const note = await getDailyNote()
        return { success: true, output: note.body || '(empty)' }
      }

      case 'spawn_agent': {
        const agentId = await spawnAgent(args.name, args.task, args.model)
        return { success: true, output: `Agent spawned: ${agentId}` }
      }

      case 'wait_for_agents': {
        const ids = args.agent_ids.split(',').map((s) => s.trim())
        const results = await waitForAgents(ids)
        return {
          success: true,
          output: Object.entries(results)
            .map(([id, result]) => `[${id}]\n${result}`)
            .join('\n\n'),
        }
      }

      default:
        return { success: false, output: `Unknown tool: ${name}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[tool] ${name} failed`, msg)
    return { success: false, output: `Error: ${msg}` }
  }
}
