import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { sessions, messages, todos } from './store/db.js'
import { Orchestrator } from './agents/orchestrator.js'
import { chat } from './llm/client.js'
import type { AgentEvent } from './agents/base.js'
import log, { type LogEntry } from './logger.js'
import { listNotes } from './brain/index.js'
import { startHeartbeat, stopHeartbeat } from './heartbeat.js'
import { startScheduler, stopScheduler } from './scheduler.js'
import { initMcp, shutdownMcp } from './mcp/client.js'
import { startTelegram } from './channels/telegram.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = Fastify({ logger: false })

await app.register(websocket)
await app.register(staticFiles, {
  root: join(__dirname, '..', 'src', 'ui', 'public'),
  prefix: '/',
})

// Track active orchestrators per session
const activeOrchestrators = new Map<string, Orchestrator>()
// Track WebSocket clients per session
const sessionClients = new Map<string, Set<import('@fastify/websocket').WebSocket>>()
// All connected debug clients
const debugClients = new Set<import('@fastify/websocket').WebSocket>()
// Recent log buffer (last 500 entries)
const logBuffer: LogEntry[] = []

log.onLog((entry) => {
  logBuffer.push(entry)
  if (logBuffer.length > 500) logBuffer.shift()
  const payload = JSON.stringify({ type: 'log', entry })
  for (const ws of debugClients) {
    if (ws.readyState === 1) ws.send(payload)
  }
})

function broadcast(sessionId: string, data: unknown) {
  const clients = sessionClients.get(sessionId)
  if (!clients) return
  const payload = JSON.stringify(data)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload)
  }
}

function runMessage(sessionId: string, content: string, isFirstMessage: boolean) {
  const orchestrator = new Orchestrator(sessionId, (event: AgentEvent) => {
    broadcast(sessionId, { type: 'agent_event', event })
  })
  activeOrchestrators.set(sessionId, orchestrator)

  orchestrator.handleMessage(content).then((result) => {
    const assistantMsg = {
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content: result,
      agent_id: null,
      agent_name: 'boss',
      metadata: null,
    }
    messages.insert(assistantMsg)
    sessions.touch(sessionId)
    broadcast(sessionId, { type: 'message', message: assistantMsg })
    activeOrchestrators.delete(sessionId)

    if (isFirstMessage) {
      chat('fast', [
        { role: 'user', content: `Summarize this conversation's goal as a short title (4-6 words, no punctuation, no quotes):\nUser: ${content}\nAssistant: ${result.slice(0, 300)}` }
      ]).then(({ content: title }) => {
        const clean = title.trim().replace(/^["']|["']$/g, '').slice(0, 60)
        sessions.updateTitle(sessionId, clean)
        broadcast(sessionId, { type: 'session_renamed', sessionId, title: clean })
      }).catch(() => {})
    }
  }).catch((err) => {
    broadcast(sessionId, { type: 'error', message: err.message })
    activeOrchestrators.delete(sessionId)
  })
}

// REST: recent logs
app.get('/api/logs', async () => logBuffer)

// REST: list sessions
app.get('/api/sessions', async () => {
  return sessions.list()
})

// REST: get session messages
app.get<{ Params: { id: string } }>('/api/sessions/:id/messages', async (req) => {
  return messages.list(req.params.id)
})

// REST: create session
app.post('/api/sessions', async () => {
  const id = randomUUID()
  return sessions.create(id, undefined, 'goal')
})

// REST: todos
app.get('/api/todos', async () => todos.list())
app.post<{ Body: { title: string; priority?: number; notes?: string } }>('/api/todos', async (req) => {
  const { title, priority, notes } = req.body
  return todos.create(randomUUID(), title, priority ?? 0, notes)
})
app.patch<{ Params: { id: string }; Body: { title?: string; status?: 'todo' | 'in_progress' | 'done'; priority?: number; notes?: string } }>('/api/todos/:id', async (req) => {
  return todos.update(req.params.id, req.body)
})
app.delete<{ Params: { id: string } }>('/api/todos/:id', async (req) => {
  todos.delete(req.params.id)
  return { ok: true }
})

// WebSocket: main comms channel
app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    let currentSessionId: string | null = null

    socket.on('message', async (raw: Buffer) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      // Subscribe to debug logs
      if (msg.type === 'debug_subscribe') {
        debugClients.add(socket)
        socket.send(JSON.stringify({ type: 'log_history', entries: logBuffer }))
        return
      }

      // Join/create a session
      if (msg.type === 'join') {
        const requestedId = msg.session_id as string | undefined
        // If no session requested, resume the most recent one (or create new)
        const sessionId = requestedId
          ?? sessions.list()[0]?.id
          ?? randomUUID()

        if (!sessions.get(sessionId)) {
          sessions.create(sessionId, undefined, 'goal')
        }

        currentSessionId = sessionId
        if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set())
        sessionClients.get(sessionId)!.add(socket)

        socket.send(JSON.stringify({
          type: 'joined',
          session_id: sessionId,
          messages: messages.list(sessionId),
        }))
        return
      }

      // Send a message
      if (msg.type === 'message') {
        if (!currentSessionId) {
          socket.send(JSON.stringify({ type: 'error', message: 'Not in a session' }))
          return
        }

        const content = msg.content as string
        if (!content?.trim()) return

        const sessionId = currentSessionId

        // Save user message
        const userMsg = {
          id: randomUUID(),
          session_id: sessionId,
          role: 'user',
          content,
          agent_id: null,
          agent_name: null,
          metadata: null,
        }
        messages.insert(userMsg)
        sessions.touch(sessionId)

        const isFirstMessage = messages.list(sessionId).length <= 1

        broadcast(sessionId, { type: 'message', message: userMsg })

        // If already running, inject into the active agent
        if (activeOrchestrators.has(sessionId)) {
          activeOrchestrators.get(sessionId)!.inject(content)
          return
        }

        runMessage(sessionId, content, isFirstMessage)

        return
      }

      // Abort current run
      if (msg.type === 'abort') {
        if (currentSessionId) {
          activeOrchestrators.get(currentSessionId)?.abortAll()
          activeOrchestrators.delete(currentSessionId)
          broadcast(currentSessionId, { type: 'aborted' })
        }
        return
      }
    })

    socket.on('close', () => {
      if (currentSessionId) {
        sessionClients.get(currentSessionId)?.delete(socket)
      }
      debugClients.delete(socket)
    })
  })
})

async function isFirstRun(): Promise<boolean> {
  const allSessions = sessions.list()
  if (allSessions.length > 0) return false
  const notes = await listNotes()
  return notes.length === 0
}

const ONBOARDING_MESSAGE = `Hey — I'm eggbot. I just started up and my brain is empty.

To work well for you, I'd love to know a bit about you: who you are, what you do, what machines and tools you use, ongoing projects, and anything else I should know. The more you share, the better I'll serve you — I'll remember everything in my brain and use it in every future conversation.

What should I know about you?`

export async function startServer() {
  await app.listen({ port: config.server.port, host: config.server.host })
  log.info(`eggbot running at http://localhost:${config.server.port}`)
  console.log(`eggbot running at http://localhost:${config.server.port}`)

  // Init MCP servers before starting background runners
  if (config.mcp?.servers?.length) {
    await initMcp(config.mcp.servers)
  }

  const broadcastFn = (sessionId: string, data: unknown) => broadcast(sessionId, data)
  startHeartbeat(broadcastFn)
  startScheduler(broadcastFn)

  if (config.telegram?.token) {
    startTelegram(
      config.telegram.token,
      config.telegram.allowedUsers ?? [],
      broadcastFn
    ).catch(err => log.error('[telegram] Failed to start', err.message))
  }

  if (await isFirstRun()) {
    log.info('First run detected — creating onboarding session')
    const sessionId = randomUUID()
    sessions.create(sessionId, 'Getting started', 'goal')
    messages.insert({
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content: ONBOARDING_MESSAGE,
      agent_id: null,
      agent_name: 'eggbot',
      metadata: null,
    })
  }
}
