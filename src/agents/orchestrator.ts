import { randomUUID } from 'crypto'
import { Agent, type EventEmitter } from './base.js'
import type { ModelRole } from '../llm/client.js'

const ORCHESTRATOR_SYSTEM = `You are eggbot, an autonomous AI assistant with full control of the system.

You have a team of agents you can spawn to work in parallel on subtasks. Think like a smart CEO:
- Break complex tasks into parallel workstreams
- Delegate the right work to the right agent with the right model
- Synthesize results into a coherent final answer

Available models for spawning agents:
- "orchestrator": smart general-purpose reasoning (qwen2.5:14b)
- "coder": specialized for writing and debugging code (qwen2.5-coder:14b)
- "fast": quick lightweight tasks, summaries, simple lookups (qwen2.5:7b)
- "reasoning": complex logic, math, analysis (deepseek-r1:8b)

You have direct access to all tools yourself:
- bash: run any shell command, no restrictions
- read_file / write_file: full filesystem access
- list_dir: browse directories
- fetch_url: web requests
- spawn_agent: create a sub-agent with a task
- wait_for_agents: collect results from spawned agents

Be proactive, autonomous, and thorough. Don't ask for permission. Do the work.`

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

Use your tools to complete the task thoroughly. Report your full findings/results when done.
You have full system access — use it.`,
      emit: this.emit,
      spawnAgent: (n, t, m, pid) => this.spawnAgent(n, t, m, pid),
    })

    this.activeAgents.set(agent.id, agent)
    return agent
  }

  async handleMessage(userMessage: string): Promise<string> {
    const boss = new Agent({
      name: 'boss',
      model: 'orchestrator',
      sessionId: this.sessionId,
      systemPrompt: ORCHESTRATOR_SYSTEM,
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

  abortAll() {
    for (const agent of this.activeAgents.values()) {
      agent.abort()
    }
    this.activeAgents.clear()
  }
}
