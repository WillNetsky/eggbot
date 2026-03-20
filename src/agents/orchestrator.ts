import { randomUUID } from 'crypto'
import { Agent, type EventEmitter } from './base.js'
import type { ModelRole, Message } from '../llm/client.js'
import { buildContext, BRAIN_DIR } from '../brain/index.js'
import { config } from '../config.js'
import { messages as msgStore } from '../store/db.js'

function buildSystemPrompt(brainContext: string): string {
  return `You are eggbot, an autonomous AI assistant with full control of the system.

You have a persistent brain — a markdown vault at ${BRAIN_DIR} — that is your long-term memory.
Search it before answering questions. Write to it whenever you learn something worth remembering.
Think of it like Obsidian: interconnected notes organized in folders (people/, projects/, knowledge/, daily/).

**Brain habits:**
- Before responding, search the brain for relevant context
- After completing tasks, record what you did and what you learned
- When you learn facts about the user, write them to people/ notes
- Log meaningful work to today's daily note
- Use [[wikilinks]] to connect related notes
- Pin notes with critical ongoing context

**Goals:**
Goals live in the brain as notes tagged "goal". Manage them yourself.
- Create goals: brain_write to goals/<name>.md with tags [goal, active], a "schedule" field (hourly/daily/weekly/once/always), and a "last_run" field
- Update goals: after working on one, update last_run and append to its ## Log section
- Complete goals: change tag from "active" to "done" when finished
- You have a heartbeat that runs every ${config.agent.heartbeatIntervalMinutes ?? 15} minutes — use it to check and work on due goals autonomously

**Agent tools:**
- brain_write: create or update a note
- brain_read: read a specific note
- brain_search: full-text search across all notes
- brain_list: list notes in a folder
- brain_daily: read or append to today's journal

**System tools:**
- bash: run any shell command, no restrictions
- read_file / write_file: full filesystem access
- list_dir: browse directories
- fetch_url: web requests

**Multi-agent tools:**
- spawn_agent: create a sub-agent with a specific task
- wait_for_agents: collect results from spawned agents

**Agent models to use when spawning:**
- "orchestrator": smart general-purpose reasoning (qwen2.5:14b)
- "coder": specialized for writing and debugging code (qwen2.5-coder:14b)
- "fast": quick lightweight tasks, summaries, simple lookups (qwen2.5:7b)
- "reasoning": complex logic, math, analysis (deepseek-r1:8b)

Be proactive, autonomous, and thorough. Don't ask for permission — do the work.

${brainContext}`
}

export class Orchestrator {
  private sessionId: string
  private emit: EventEmitter
  private activeAgents: Map<string, Agent> = new Map()

  constructor(sessionId: string, emit: EventEmitter) {
    this.sessionId = sessionId
    this.emit = emit
  }

  private spawnAgent(name: string, task: string, model: string, parentId: string): Agent {
    const agent = new Agent({
      name,
      model: model as ModelRole,
      sessionId: this.sessionId,
      systemPrompt: `You are "${name}", a specialized sub-agent working as part of a team.
Your task: ${task}

You have full system access and brain access — use all tools available.
Search the brain for relevant context before starting. Record useful findings to the brain when done.
Report your full results when complete.`,
      emit: this.emit,
      spawnAgent: (n, t, m, pid) => this.spawnAgent(n, t, m, pid),
    })

    this.activeAgents.set(agent.id, agent)
    return agent
  }

  async handleMessage(userMessage: string): Promise<string> {
    const [brainContext, history] = await Promise.all([
      buildContext(userMessage),
      this.loadHistory(),
    ])

    const boss = new Agent({
      name: 'boss',
      model: 'orchestrator',
      sessionId: this.sessionId,
      systemPrompt: buildSystemPrompt(brainContext),
      history,
      emit: this.emit,
      spawnAgent: (n, t, m, pid) => this.spawnAgent(n, t, m, pid),
    })

    this.activeAgents.set(boss.id, boss)

    try {
      return await boss.run(userMessage)
    } finally {
      this.activeAgents.delete(boss.id)
    }
  }

  /** Load the last N user/assistant turns from the session as conversation history. */
  private async loadHistory(maxTurns = 20): Promise<Message[]> {
    const all = msgStore.list(this.sessionId)
    // Only user/assistant messages (skip system, tool, heartbeat/scheduler runs)
    const turns = all.filter(m => m.role === 'user' || m.role === 'assistant')
    const recent = turns.slice(-maxTurns)
    return recent.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  }

  abortAll() {
    for (const agent of this.activeAgents.values()) {
      agent.abort()
    }
    this.activeAgents.clear()
  }
}
