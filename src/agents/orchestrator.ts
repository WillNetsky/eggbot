import { randomUUID } from 'crypto'
import { Agent, type EventEmitter } from './base.js'
import type { ModelRole, Message } from '../llm/client.js'
import { buildContext, BRAIN_DIR } from '../brain/index.js'
import { config } from '../config.js'
import { messages as msgStore, sessions } from '../store/db.js'

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

**Every conversation is a goal.**
When a user talks to you, they are working toward something. Your job:
1. On the first message of a new conversation, identify what the user is trying to achieve
2. Create a goal note in the brain at goals/<slug>.md with tags [goal, active] and a "schedule" field
3. Call set_session_goal with that note path — this links the conversation thread to the goal permanently
4. Work the goal across the conversation; update last_run and the ## Log section as you make progress
5. When the goal is achieved, change tag from "active" to "done"

If the user's message clearly maps to an existing goal, use set_session_goal to link to it instead of creating a new one.

Goal notes format:
\`\`\`
schedule: once|daily|weekly|hourly|always
last_run: YYYY-MM-DD

## Description
What this goal is about.

## Log
### YYYY-MM-DD
What was done.
\`\`\`

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

**How to behave:**
- Writing text without calling a tool accomplishes nothing. If you're not calling a tool, you're not working.
- Every response must either call tools to make progress, or be a final summary after the work is done.
- Never describe what you're going to do — just do it. No preamble, no plan summaries, no "I'll start by...".
- Never ask for clarification or permission. Pick an interpretation and start.
- For any real task: spawn a coder agent to write code, use bash to run it, use write_file to save files.
- Spawn agents in parallel when tasks can be done concurrently.
- Only send a plain text response (no tool calls) when the task is complete and you're reporting results.

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
      systemPrompt: `You are "${name}", a specialized sub-agent. Your task: ${task}

Use tools to do the work. Writing text without calling tools does nothing.
- Use bash to run commands
- Use write_file / read_file for files
- Use brain_write to record findings
Only send a plain text response when the task is fully complete.`,
      emit: this.emit,
      spawnAgent: (n, t, m, pid) => this.spawnAgent(n, t, m, pid),
      setGoalRef: (path) => sessions.setGoalRef(this.sessionId, path),
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
      setGoalRef: (path) => sessions.setGoalRef(this.sessionId, path),
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

  inject(message: string) {
    // Inject into the boss agent (first active agent, or all)
    for (const agent of this.activeAgents.values()) {
      if (agent.name === 'boss') {
        agent.inject(message)
        return
      }
    }
    // Fallback: inject into all active agents
    for (const agent of this.activeAgents.values()) {
      agent.inject(message)
    }
  }

  abortAll() {
    for (const agent of this.activeAgents.values()) {
      agent.abort()
    }
    this.activeAgents.clear()
  }
}
