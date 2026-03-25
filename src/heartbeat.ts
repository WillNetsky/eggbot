/**
 * Heartbeat — periodic autonomous pulse.
 *
 * Fires every N minutes. All pulses accumulate in one persistent heartbeat
 * thread rather than spawning a new session each time.
 */

import { Orchestrator } from './agents/orchestrator.js'
import { sessions, messages, todos } from './store/db.js'
import { randomUUID } from 'crypto'
import { config } from './config.js'
import log from './logger.js'
import type { AgentEvent } from './agents/base.js'

type Broadcast = (sessionId: string, data: unknown) => void

const INTERVAL_MS = (config.agent.heartbeatIntervalMinutes ?? 15) * 60 * 1000

let timer: ReturnType<typeof setTimeout> | null = null
let beating = false

function buildHeartbeatPrompt(): string {
  const openTodos = todos.list('todo')
  const inProgress = todos.list('in_progress')
  const allOpen = [...inProgress, ...openTodos]

  let todoSection = ''
  if (allOpen.length > 0) {
    const lines = allOpen.map(t =>
      `  [${t.id.slice(0, 8)}] [${t.status}] ${t.priority ? '⚡ ' : ''}${t.title}${t.notes ? ` — ${t.notes}` : ''}`
    ).join('\n')
    todoSection = `\n\nCurrent todo list (${allOpen.length} open):\n${lines}\n\nConsider picking one of these up if it's actionable right now. Use todo_update to mark it in_progress or done as you work on it. Use todo_add if you notice something new worth tracking.`
  } else {
    todoSection = `\n\nThe todo list is empty. If you notice anything worth tracking from recent conversations, add it with todo_add.`
  }

  return `This is your autonomous heartbeat. No user is present — this is YOUR time to get work done.

You are the boss of a team of agents. Act like it. Your job right now:

1. **Work the todo list.** If there are actionable todos, DO them — spawn coder agents, run bash commands, make progress. Mark items in_progress when you start, done when you finish. This is your #1 priority.
2. **Create new todos** when you notice things that need doing from brain notes, goals, or recent conversations.
3. **Update the daily note** with what you accomplished this pulse.
4. **Reflect briefly** — extract anything worth remembering into brain notes.

Do NOT just report on the state of things. Do NOT describe what you could do. Actually do the work.
If there's genuinely nothing to do, keep the pulse short.${todoSection}`
}

export function startHeartbeat(broadcast: Broadcast) {
  log.info(`[heartbeat] Starting — pulse every ${config.agent.heartbeatIntervalMinutes ?? 15} minutes`)
  scheduleNext(broadcast)
}

export function stopHeartbeat() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleNext(broadcast: Broadcast) {
  timer = setTimeout(async () => {
    await pulse(broadcast)
    scheduleNext(broadcast)
  }, INTERVAL_MS)
}

export async function pulse(broadcast: Broadcast) {
  if (beating) {
    log.debug('[heartbeat] Already running, skipping pulse')
    return
  }

  beating = true
  log.info('[heartbeat] Pulse')

  try {
    // All pulses go into the same persistent heartbeat thread
    const session = sessions.getOrCreateHeartbeat()
    const sessionId = session.id

    const emit = (event: AgentEvent) => {
      broadcast(sessionId, { type: 'agent_event', event })
    }

    // Insert a separator so pulses are visually distinct in the thread
    const pulseHeader = `--- Heartbeat ${new Date().toISOString().slice(0, 16)} ---`
    messages.insert({
      id: randomUUID(),
      session_id: sessionId,
      role: 'user',
      content: pulseHeader,
      agent_id: null,
      agent_name: null,
      metadata: JSON.stringify({ type: 'heartbeat_pulse' }),
    })

    const orchestrator = new Orchestrator(sessionId, emit)
    const result = await orchestrator.handleMessage(buildHeartbeatPrompt())

    if (result.trim()) {
      messages.insert({
        id: randomUUID(),
        session_id: sessionId,
        role: 'assistant',
        content: result,
        agent_id: null,
        agent_name: 'heartbeat',
        metadata: JSON.stringify({ type: 'heartbeat' }),
      })

      sessions.touch(sessionId)

      broadcast(sessionId, {
        type: 'message',
        message: { role: 'assistant', content: result, agent_name: 'heartbeat' },
      })
    }

    log.info('[heartbeat] Pulse complete')
  } catch (err) {
    log.error('[heartbeat] Pulse failed', err instanceof Error ? err.message : String(err))
  } finally {
    beating = false
  }
}
