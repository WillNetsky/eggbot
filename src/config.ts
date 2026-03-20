import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  }
}

function loadConfig(): Config {
  const path = join(__dirname, '..', 'eggbot.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as Config
}

export const config = loadConfig()
