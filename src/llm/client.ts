import { config } from '../config.js'
import log from '../logger.js'

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

  log.debug(`[llm] → ${modelName}`, { tools: tools?.map(t => t.function.name), messages: messages.length })

  // Ollama expects tool_call arguments as objects in message history, not strings.
  const normalizedMessages = messages.map(msg => {
    if (!msg.tool_calls?.length) return msg
    return {
      ...msg,
      tool_calls: msg.tool_calls.map(tc => ({
        ...tc,
        function: {
          ...tc.function,
          arguments: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        },
      })),
    }
  })
  body.messages = normalizedMessages

  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const text = await res.text()
    log.error(`[llm] Ollama error ${res.status}`, text)
    throw new Error(`Ollama error: ${res.status} ${text}`)
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

      // Tool calls — Ollama returns arguments as an object, not a JSON string.
      // Normalize to OpenAI format (string arguments, guaranteed id).
      const rawToolCalls = msg.tool_calls as Array<{
        id?: string
        function: { name: string; arguments: unknown }
      }> | undefined
      if (rawToolCalls && rawToolCalls.length > 0) {
        pendingToolCalls = rawToolCalls.map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments),
          },
        }))
      }

      if (parsed.done) {
        if (pendingToolCalls.length > 0) {
          log.debug(`[llm] tool_calls`, pendingToolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments })))
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
