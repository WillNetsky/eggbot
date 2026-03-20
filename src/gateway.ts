import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import staticFiles from '@fastify/static'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { sessions, messages } from './store/db.js'
import { Orchestrator } from './agents/orchestrator.js'
import type { AgentEvent } from './agents/base.js'

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

function broadcast(sessionId: string, data: unknown) {
  const clients = sessionClients.get(sessionId)
  if (!clients) return
  const payload = JSON.stringify(data)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload)
  }
}

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
  return sessions.create(id)
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

      // Join/create a session
      if (msg.type === 'join') {
        const sessionId = (msg.session_id as string | undefined) ?? randomUUID()

        if (!sessions.get(sessionId)) {
          sessions.create(sessionId)
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

        // Auto-title session from first message
        const existing = messages.list(sessionId)
        if (existing.length <= 1) {
          const title = content.length > 60 ? content.slice(0, 57) + '...' : content
          sessions.updateTitle(sessionId, title)
        }

        broadcast(sessionId, { type: 'message', message: userMsg })

        // Abort any existing run for this session
        activeOrchestrators.get(sessionId)?.abortAll()

        // Create orchestrator
        const orchestrator = new Orchestrator(sessionId, (event: AgentEvent) => {
          broadcast(sessionId, { type: 'agent_event', event })
        })
        activeOrchestrators.set(sessionId, orchestrator)

        // Run async
        orchestrator.handleMessage(content).then((result) => {
          // Save assistant message
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
        }).catch((err) => {
          broadcast(sessionId, { type: 'error', message: err.message })
          activeOrchestrators.delete(sessionId)
        })

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
    })
  })
})

export async function startServer() {
  await app.listen({ port: config.server.port, host: config.server.host })
  console.log(`eggbot running at http://localhost:${config.server.port}`)
}
