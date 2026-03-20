import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

interface Config {
  ollama: {
    host: string
    models: {
      orchestrator: string
      coder: string
      fast: string
      reasoning: string
    }
  }
  server: {
    port: number
    host: string
  }
  agent: {
    maxWorkers: number
    maxIterations: number
    systemName: string
    goalIntervalMinutes?: number
    heartbeatIntervalMinutes?: number
  }
  mcp?: {
    servers: McpServerConfig[]
  }
}

function loadConfig(): Config {
  const path = join(__dirname, '..', 'eggbot.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as Config
}

export const config = loadConfig()
