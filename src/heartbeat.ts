/**
 * Heartbeat — periodic autonomous pulse.
 *
 * Fires every N minutes. Gives eggbot a chance to:
 * - Reflect on recent activity
 * - Notice things that need attention
 * - Work on due goals (delegates to scheduler)
 * - Update the daily note
 * - Do anything it thinks is useful unprompted
 */

import { Orchestrator } from './agents/orchestrator.js'
import { sessions, messages } from './store/db.js'
import { randomUUID } from 'crypto'
import { config } from './config.js'
import log from './logger.js'
import { runGoals } from './scheduler.js'
import type { AgentEvent } from './agents/base.js'

type Broadcast = (sessionId: string, data: unknown) => void

const INTERVAL_MS = (config.agent.heartbeatIntervalMinutes ?? 15) * 60 * 1000

let timer: ReturnType<typeof setTimeout> | null = null
let beating = false

const HEARTBEAT_PROMPT = `This is your autonomous heartbeat. No user is present right now.

Take this time to:
1. Check the brain for any active goals that are due — work on them if so (or let the goal runner handle them)
2. Reflect on recent conversations and extract anything worth remembering into the brain
3. Notice any loose ends, upcoming things, or items that need follow-up
4. Update today's daily note with a brief status entry if there's anything worth noting
5. Do any proactive work you think would be useful for the user

Keep it lightweight if there's nothing pressing. Don't manufacture work.
Check the date and time with bash if you need context on what "today" means.`

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
    // Run goals in parallel with the reflection
    runGoals(broadcast).catch(err => {
      log.error('[heartbeat] Goal run error', err instanceof Error ? err.message : String(err))
    })

    const sessionId = randomUUID()
    sessions.create(sessionId, `Heartbeat ${new Date().toISOString().slice(0, 16)}`)

    const emit = (event: AgentEvent) => {
      broadcast(sessionId, { type: 'agent_event', event })
    }

    const orchestrator = new Orchestrator(sessionId, emit)
    const result = await orchestrator.handleMessage(HEARTBEAT_PROMPT)

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
