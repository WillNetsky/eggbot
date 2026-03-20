/**
 * Background goal runner.
 *
 * Wakes up on a configurable interval, reads all notes tagged "goal" + "active"
 * from the brain, and lets the orchestrator decide which ones need attention.
 * Results are written back to the goal notes and the daily log.
 */

import { searchByTag, readNote, buildContext } from './brain/index.js'
import { Orchestrator } from './agents/orchestrator.js'
import { sessions, messages } from './store/db.js'
import { randomUUID } from 'crypto'
import log from './logger.js'
import type { AgentEvent } from './agents/base.js'
import { config } from './config.js'

type Broadcast = (sessionId: string, data: unknown) => void

const INTERVAL_MS = (config.agent.goalIntervalMinutes ?? 30) * 60 * 1000

const GOAL_RUNNER_PROMPT = `You are running an autonomous background goal review.

1. Use brain_search to find all notes tagged "goal" and "active".
2. Read each goal note with brain_read.
3. For each active goal, check its "schedule" and "last_run" fields to decide if it's due.
   - "hourly"  → due if last_run was >1 hour ago or missing
   - "daily"   → due if last_run was not today
   - "weekly"  → due if last_run was >7 days ago or missing
   - "always"  → always due
   - "once"    → due only if last_run is missing (one-time task)
4. For each due goal, spawn an appropriate agent to carry out the work.
5. After each goal is worked on, update the goal note:
   - Set "last_run" to today's date
   - Append a dated entry to the "## Log" section with a summary of what was done
   - If the goal is "once" and now complete, change the "active" tag to "done"
6. Append a summary of all work done to today's daily brain note.

Be thorough but efficient. Skip goals that are not due. Do real work, not placeholders.`

let running = false
let timer: ReturnType<typeof setTimeout> | null = null

export function startScheduler(broadcast: Broadcast) {
  log.info(`[scheduler] Starting — checking goals every ${config.agent.goalIntervalMinutes ?? 30} minutes`)
  scheduleNext(broadcast)
}

export function stopScheduler() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function scheduleNext(broadcast: Broadcast) {
  timer = setTimeout(async () => {
    await runGoals(broadcast)
    scheduleNext(broadcast)
  }, INTERVAL_MS)
}

export async function runGoals(broadcast: Broadcast) {
  if (running) {
    log.info('[scheduler] Goal run already in progress, skipping')
    return
  }

  // Check if there are any active goals at all before spinning up
  const activeGoals = searchByTag('goal').filter(n => {
    // We stored tags as comma-separated in the index — re-check they also have 'active'
    return true // orchestrator will filter; just check there's something
  })

  if (activeGoals.length === 0) {
    log.debug('[scheduler] No goal notes found, skipping run')
    return
  }

  running = true
  log.info('[scheduler] Running goal check')

  try {
    // Create a background session for this run
    const sessionId = randomUUID()
    sessions.create(sessionId, `Goal run ${new Date().toISOString().slice(0, 16)}`)

    const emit = (event: AgentEvent) => {
      broadcast(sessionId, { type: 'agent_event', event })
      if (event.type === 'error') {
        log.error(`[scheduler] Agent error: ${event.message}`)
      }
    }

    const orchestrator = new Orchestrator(sessionId, emit)
    const result = await orchestrator.handleMessage(GOAL_RUNNER_PROMPT)

    // Save result to session
    messages.insert({
      id: randomUUID(),
      session_id: sessionId,
      role: 'assistant',
      content: result,
      agent_id: null,
      agent_name: 'scheduler',
      metadata: JSON.stringify({ type: 'goal_run' }),
    })

    broadcast(sessionId, {
      type: 'message',
      message: { role: 'assistant', content: result, agent_name: 'scheduler' },
    })

    log.info('[scheduler] Goal run complete')
  } catch (err) {
    log.error('[scheduler] Goal run failed', err instanceof Error ? err.message : String(err))
  } finally {
    running = false
  }
}
