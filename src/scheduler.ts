/**
 * Background goal runner.
 *
 * Wakes up on a configurable interval, reads all notes tagged "goal" + "active",
 * checks which are due, and for each due goal runs a focused orchestrator
 * inside that goal's own persistent session thread.
 *
 * Loop mode (Ralph technique): if a goal note has `loop: true`, the scheduler
 * re-runs the goal immediately after each iteration until the agent outputs
 * <done>COMPLETION_PROMISE</done> or max_iterations is reached.
 */

import { searchByTag, readNote } from './brain/index.js'
import { Orchestrator } from './agents/orchestrator.js'
import { sessions, messages } from './store/db.js'
import { randomUUID } from 'crypto'
import log from './logger.js'
import type { AgentEvent } from './agents/base.js'
import { config } from './config.js'

type Broadcast = (sessionId: string, data: unknown) => void

const INTERVAL_MS = (config.agent.goalIntervalMinutes ?? 30) * 60 * 1000

let running = false
let timer: ReturnType<typeof setTimeout> | null = null

function isDue(schedule: string | undefined, lastRun: string | undefined): boolean {
  if (!schedule || schedule === 'always') return true
  if (schedule === 'once') return !lastRun

  const last = lastRun ? new Date(lastRun).getTime() : 0
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)

  if (schedule === 'hourly') return now - last > 60 * 60 * 1000
  if (schedule === 'daily') return lastRun !== today
  if (schedule === 'weekly') return now - last > 7 * 24 * 60 * 60 * 1000

  return false
}

function goalPrompt(noteContent: string, completionPromise?: string, iteration?: number): string {
  const iterNote = (iteration && iteration > 1)
    ? `\nThis is iteration ${iteration}. Check your previous ## Log entries to see what was attempted and what failed. Build on prior work — don't start from scratch.\n`
    : ''

  const completionNote = completionPromise
    ? `\nWhen the goal is FULLY and COMPLETELY achieved (not partially, not in progress), output exactly this on its own line:\n<done>${completionPromise}</done>\n\nDo NOT output this unless the goal is unequivocally complete. Do not output it to escape the loop.\n`
    : ''

  return `You are working on a specific goal. Here is the goal note:

${noteContent}

This goal is due. Work on it now:
- Do the actual work described in the goal
- After completing, update the goal note using brain_write:
  - Set the "last_run" field to today's date
  - Append a dated entry to the "## Log" section with a summary of what was done
  - If the goal has schedule "once" and is now complete, change tag "active" to "done"
${iterNote}${completionNote}
Be thorough. Report what you did when finished.`
}

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

  const goalNotes = searchByTag('goal')
  if (goalNotes.length === 0) {
    log.debug('[scheduler] No goal notes found, skipping run')
    return
  }

  running = true
  log.info('[scheduler] Running goal check')

  try {
    for (const ref of goalNotes) {
      const note = await readNote(ref.path)
      if (!note) continue

      // Only process active goals
      if (!note.meta.tags.includes('active')) continue

      // Parse schedule/last_run from the note body
      const scheduleMatch = note.body.match(/^schedule:\s*(.+)$/m)
      const lastRunMatch = note.body.match(/^last_run:\s*(.+)$/m)
      const schedule = scheduleMatch?.[1]?.trim()
      const lastRun = lastRunMatch?.[1]?.trim()

      if (!isDue(schedule, lastRun)) {
        log.debug(`[scheduler] Goal not due: ${ref.path}`)
        continue
      }

      // Parse loop fields
      const loopMatch = note.body.match(/^loop:\s*(.+)$/m)
      const maxIterMatch = note.body.match(/^max_iterations:\s*(\d+)$/m)
      const promiseMatch = note.body.match(/^completion_promise:\s*(.+)$/m)

      const isLoop = loopMatch?.[1]?.trim() === 'true'
      const maxIterations = maxIterMatch ? parseInt(maxIterMatch[1]) : 5
      const completionPromise = promiseMatch?.[1]?.trim()

      log.info(`[scheduler] Working on goal: ${ref.path}${isLoop ? ` (loop mode, max ${maxIterations} iterations)` : ''}`)

      // Each goal has its own persistent session thread
      const session = sessions.getOrCreateForGoal(ref.path, note.meta.title || ref.path)
      const sessionId = session.id

      const emit = (event: AgentEvent) => {
        broadcast(sessionId, { type: 'agent_event', event })
        if (event.type === 'error') {
          log.error(`[scheduler] Agent error: ${event.message}`)
        }
      }

      const maxIter = isLoop ? maxIterations : 1
      let goalAchieved = false

      for (let iteration = 1; iteration <= maxIter && !goalAchieved; iteration++) {
        // Re-read the note on subsequent iterations — agent may have updated it
        const currentNote = iteration > 1 ? (await readNote(ref.path)) ?? note : note

        const runHeader = isLoop
          ? `--- Goal run ${new Date().toISOString().slice(0, 16)} (iteration ${iteration}/${maxIter}) ---`
          : `--- Goal run ${new Date().toISOString().slice(0, 16)} ---`

        messages.insert({
          id: randomUUID(),
          session_id: sessionId,
          role: 'user',
          content: runHeader,
          agent_id: null,
          agent_name: null,
          metadata: JSON.stringify({ type: 'goal_run' }),
        })

        try {
          const orchestrator = new Orchestrator(sessionId, emit)
          const result = await orchestrator.handleMessage(
            goalPrompt(currentNote.raw, completionPromise, iteration)
          )

          messages.insert({
            id: randomUUID(),
            session_id: sessionId,
            role: 'assistant',
            content: result,
            agent_id: null,
            agent_name: 'scheduler',
            metadata: JSON.stringify({ type: 'goal_run' }),
          })

          sessions.touch(sessionId)

          broadcast(sessionId, {
            type: 'message',
            message: { role: 'assistant', content: result, agent_name: 'scheduler' },
          })

          // Check for completion signal
          if (completionPromise && result.includes(`<done>${completionPromise}</done>`)) {
            goalAchieved = true
            log.info(`[scheduler] Goal achieved on iteration ${iteration}: ${ref.path}`)
          } else if (isLoop && iteration < maxIter) {
            log.info(`[scheduler] Completion signal not found, re-running (${iteration}/${maxIter}): ${ref.path}`)
          }
        } catch (err) {
          log.error(`[scheduler] Goal failed on iteration ${iteration}: ${ref.path}`, err instanceof Error ? err.message : String(err))
          break
        }
      }

      if (isLoop && !goalAchieved) {
        log.warn(`[scheduler] Goal hit max iterations (${maxIterations}) without completion: ${ref.path}`)
      }
    }

    log.info('[scheduler] Goal check complete')
  } finally {
    running = false
  }
}
