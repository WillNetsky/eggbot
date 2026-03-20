/**
 * MCP client layer.
 *
 * Connects to configured MCP servers at startup, discovers their tools,
 * and makes them available to agents alongside built-in tools.
 * Tools are prefixed: mcp_<servername>_<toolname>
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '../llm/client.js'
import log from '../logger.js'

export interface McpServerConfig {
  name: string
  command?: string                    // stdio: first word is the executable
  args?: string[]                     // extra args appended after command's own args
  url?: string                        // HTTP/SSE server URL
  headers?: Record<string, string>   // HTTP headers (e.g. Authorization for remote servers)
  env?: Record<string, string>        // env vars for stdio servers
}

interface McpServer {
  name: string
  client: Client
  tools: Tool[]
}

const servers = new Map<string, McpServer>()

/** Start all configured MCP servers and discover their tools. */
export async function initMcp(configs: McpServerConfig[]) {
  for (const cfg of configs) {
    try {
      await connectServer(cfg)
    } catch (err) {
      log.error(`[mcp] Failed to connect "${cfg.name}"`, err instanceof Error ? err.message : String(err))
    }
  }
  log.info(`[mcp] Connected ${servers.size}/${configs.length} servers`)
}

async function connectServer(cfg: McpServerConfig) {
  const client = new Client({ name: 'eggbot', version: '0.1.0' })

  let transport
  if (cfg.url) {
    transport = new StreamableHTTPClientTransport(
      new URL(cfg.url),
      cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined
    )
  } else if (cfg.command) {
    const [cmd, ...defaultArgs] = cfg.command.split(' ')
    transport = new StdioClientTransport({
      command: cmd,
      args: [...defaultArgs, ...(cfg.args ?? [])],
      env: { ...process.env as Record<string, string>, ...(cfg.env ?? {}) },
    })
  } else {
    throw new Error(`Server "${cfg.name}" needs either "command" or "url"`)
  }

  await client.connect(transport)
  log.info(`[mcp] Connected: ${cfg.name}`)

  const { tools: rawTools } = await client.listTools()
  log.info(`[mcp] ${cfg.name}: ${rawTools.length} tools`)

  // Convert MCP tool definitions to our Tool format, prefixed with server name
  const tools: Tool[] = rawTools.map(t => ({
    type: 'function',
    function: {
      name: `mcp_${cfg.name}_${t.name}`,
      description: `[${cfg.name}] ${t.description ?? t.name}`,
      parameters: (t.inputSchema as Tool['function']['parameters']) ?? {
        type: 'object',
        properties: {},
      },
    },
  }))

  servers.set(cfg.name, { name: cfg.name, client, tools })
}

/** All tools from all connected MCP servers, ready to merge into TOOLS array. */
export function getMcpTools(): Tool[] {
  return [...servers.values()].flatMap(s => s.tools)
}

/** Execute an MCP tool call. Returns { success, output }. */
export async function callMcpTool(
  prefixedName: string,
  args: Record<string, unknown>
): Promise<{ success: boolean; output: string }> {
  // prefixedName = "mcp_<server>_<tool>"
  const withoutPrefix = prefixedName.slice(4) // strip "mcp_"
  const firstUnderscore = withoutPrefix.indexOf('_')
  const serverName = withoutPrefix.slice(0, firstUnderscore)
  const toolName = withoutPrefix.slice(firstUnderscore + 1)

  const server = servers.get(serverName)
  if (!server) {
    return { success: false, output: `MCP server not found: ${serverName}` }
  }

  log.debug(`[mcp] ${serverName}.${toolName}`, args)

  try {
    const result = await server.client.callTool({ name: toolName, arguments: args })

    const parts: string[] = []
    const content = result.content as Array<{ type: string; text?: string; mimeType?: string; resource?: unknown }>
    for (const item of content) {
      if (item.type === 'text') parts.push(item.text ?? '')
      else if (item.type === 'image') parts.push(`[image: ${item.mimeType}]`)
      else if (item.type === 'resource') parts.push(`[resource: ${JSON.stringify(item.resource)}]`)
    }

    const output = parts.join('\n') || '(no output)'
    const truncated = output.length > 8000 ? output.slice(0, 8000) + '\n...[truncated]' : output
    return { success: !result.isError, output: truncated }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`[mcp] ${serverName}.${toolName} failed`, msg)
    return { success: false, output: `MCP error: ${msg}` }
  }
}

/** Check if a tool name belongs to an MCP server. */
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp_')
}

export async function shutdownMcp() {
  for (const server of servers.values()) {
    try {
      await server.client.close()
    } catch {}
  }
  servers.clear()
}
