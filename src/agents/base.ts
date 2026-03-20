import { randomUUID } from 'crypto'
import { streamChat, chat, type Message, type ModelRole } from '../llm/client.js'
import { executeTool, TOOLS } from './tools/index.js'
import { config } from '../config.js'
import { agentRuns } from '../store/db.js'

export type AgentEvent =
  | { type: 'thinking'; agentId: string; agentName: string; delta: string }
  | { type: 'tool_call'; agentId: string; agentName: string; tool: string; args: Record<string, string> }
  | { type: 'tool_result'; agentId: string; agentName: string; tool: string; success: boolean; output: string }
  | { type: 'done'; agentId: string; agentName: string; result: string }
  | { type: 'error'; agentId: string; agentName: string; message: string }
  | { type: 'spawn'; agentId: string; agentName: string; childId: string; childName: string }

export type EventEmitter = (event: AgentEvent) => void

export class Agent {
  readonly id: string
  readonly name: string
  readonly model: ModelRole
  readonly sessionId: string
  private messages: Message[]
  private emit: EventEmitter
  private abortController: AbortController
  private childAgents: Map<string, Promise<string>> = new Map()
  private spawnAgent: (name: string, task: string, model: string, parentId: string) => Agent

  constructor(opts: {
    id?: string
    name: string
    model: ModelRole
    sessionId: string
    systemPrompt: string
    emit: EventEmitter
    spawnAgent: (name: string, task: string, model: string, parentId: string) => Agent
  }) {
    this.id = opts.id ?? randomUUID()
    this.name = opts.name
    this.model = opts.model
    this.sessionId = opts.sessionId
    this.emit = opts.emit
    this.spawnAgent = opts.spawnAgent
    this.abortController = new AbortController()

    this.messages = [{ role: 'system', content: opts.systemPrompt }]

    agentRuns.insert({
      id: this.id,
      session_id: this.sessionId,
      parent_id: null,
      name: this.name,
      model: config.ollama.models[this.model],
      status: 'running',
      created_at: Date.now(),
    })
  }

  abort() {
    this.abortController.abort()
  }

  async run(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage })

    let iterations = 0
    const maxIterations = config.agent.maxIterations

    while (iterations < maxIterations) {
      iterations++
      let thinkingText = ''

      // Stream the response
      for await (const chunk of streamChat(this.model, this.messages, TOOLS, this.abortController.signal)) {
        if (chunk.type === 'text') {
          thinkingText += chunk.delta
          this.emit({ type: 'thinking', agentId: this.id, agentName: this.name, delta: chunk.delta })
        }

        if (chunk.type === 'tool_calls') {
          // First add the assistant message with thinking + tool calls
          if (thinkingText || chunk.calls.length > 0) {
            this.messages.push({
              role: 'assistant',
              content: thinkingText,
              tool_calls: chunk.calls,
            })
          }

          // Execute each tool call
          for (const toolCall of chunk.calls) {
            let args: Record<string, string> = {}
            try {
              args = JSON.parse(toolCall.function.arguments)
            } catch {}

            this.emit({
              type: 'tool_call',
              agentId: this.id,
              agentName: this.name,
              tool: toolCall.function.name,
              args,
            })

            const result = await executeTool(
              toolCall.function.name,
              args,
              async (name, task, model) => {
                const child = this.spawnAgent(name, task, model as ModelRole, this.id)
                this.emit({ type: 'spawn', agentId: this.id, agentName: this.name, childId: child.id, childName: child.name })
                const resultPromise = child.run(task)
                this.childAgents.set(child.id, resultPromise)
                return child.id
              },
              async (ids) => {
                const results: Record<string, string> = {}
                for (const id of ids) {
                  const promise = this.childAgents.get(id)
                  if (promise) {
                    results[id] = await promise
                  } else {
                    results[id] = 'Agent not found'
                  }
                }
                return results
              }
            )

            this.emit({
              type: 'tool_result',
              agentId: this.id,
              agentName: this.name,
              tool: toolCall.function.name,
              success: result.success,
              output: result.output,
            })

            this.messages.push({
              role: 'tool',
              content: result.output,
              tool_call_id: toolCall.id,
            })
          }

          // Continue the loop to get next response
          break
        }

        if (chunk.type === 'done' && !thinkingText.includes('__tool_calls__')) {
          // No tool calls, we're done
          if (thinkingText) {
            this.messages.push({ role: 'assistant', content: thinkingText })
          }
          agentRuns.complete(this.id, 'done')
          this.emit({ type: 'done', agentId: this.id, agentName: this.name, result: thinkingText })
          return thinkingText
        }
      }

      // Check if last message was from assistant without tool calls (done)
      const last = this.messages[this.messages.length - 1]
      if (last.role === 'assistant' && !last.tool_calls?.length) {
        agentRuns.complete(this.id, 'done')
        this.emit({ type: 'done', agentId: this.id, agentName: this.name, result: last.content })
        return last.content
      }
    }

    const finalMsg = 'Max iterations reached.'
    agentRuns.complete(this.id, 'done')
    this.emit({ type: 'done', agentId: this.id, agentName: this.name, result: finalMsg })
    return finalMsg
  }
}
