import { config } from '../config.js'

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string; enum?: string[] }>
      required?: string[]
    }
  }
}

export type ModelRole = 'orchestrator' | 'coder' | 'fast' | 'reasoning'

export async function* streamChat(
  model: ModelRole,
  messages: Message[],
  tools?: Tool[],
  signal?: AbortSignal
): AsyncGenerator<{ type: 'text'; delta: string } | { type: 'tool_calls'; calls: ToolCall[] } | { type: 'done' }> {
  const modelName = config.ollama.models[model]

  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    stream: true,
    options: {
      num_ctx: 8192,
    },
  }
  if (tools && tools.length > 0) {
    body.tools = tools
  }

  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let pendingToolCalls: ToolCall[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const lines = decoder.decode(value).split('\n').filter(Boolean)
    for (const line of lines) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const msg = parsed.message as Record<string, unknown> | undefined
      if (!msg) continue

      // Text delta
      const content = msg.content as string | undefined
      if (content) {
        yield { type: 'text', delta: content }
      }

      // Tool calls
      const toolCalls = msg.tool_calls as ToolCall[] | undefined
      if (toolCalls && toolCalls.length > 0) {
        pendingToolCalls = toolCalls
      }

      if (parsed.done) {
        if (pendingToolCalls.length > 0) {
          yield { type: 'tool_calls', calls: pendingToolCalls }
        }
        yield { type: 'done' }
        return
      }
    }
  }

  yield { type: 'done' }
}

export async function chat(
  model: ModelRole,
  messages: Message[],
  tools?: Tool[]
): Promise<{ content: string; toolCalls?: ToolCall[] }> {
  let content = ''
  let toolCalls: ToolCall[] | undefined

  for await (const chunk of streamChat(model, messages, tools)) {
    if (chunk.type === 'text') content += chunk.delta
    if (chunk.type === 'tool_calls') toolCalls = chunk.calls
  }

  return { content, toolCalls }
}
