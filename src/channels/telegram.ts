/**
 * Telegram channel for eggbot.
 *
 * Creates a bot that forwards messages to the orchestrator and streams
 * responses back. One persistent session per Telegram chat.
 */

import { Bot, type Context } from 'grammy'
import { Orchestrator } from '../agents/orchestrator.js'
import { chat } from '../llm/client.js'
import { sessions, messages } from '../store/db.js'
import { randomUUID } from 'crypto'
import log from '../logger.js'
import type { AgentEvent } from '../agents/base.js'
import { runGoals } from '../scheduler.js'

type Broadcast = (sessionId: string, data: unknown) => void

// Map telegram chat ID → eggbot session ID
const chatSessions = new Map<number, string>()

// Telegram message limit
const TG_MAX_LEN = 4096

function getOrCreateSession(chatId: number, title?: string): string {
  let sessionId = chatSessions.get(chatId)
  if (!sessionId || !sessions.get(sessionId)) {
    sessionId = randomUUID()
    sessions.create(sessionId, title ?? `Telegram ${chatId}`)
    chatSessions.set(chatId, sessionId)
    log.info(`[telegram] New session for chat ${chatId}: ${sessionId}`)
  }
  return sessionId
}

function newSession(chatId: number): string {
  const sessionId = randomUUID()
  sessions.create(sessionId, `Telegram ${chatId}`)
  chatSessions.set(chatId, sessionId)
  log.info(`[telegram] Reset session for chat ${chatId}: ${sessionId}`)
  return sessionId
}

/** Split long text into Telegram-sized chunks. */
function splitMessage(text: string): string[] {
  if (text.length <= TG_MAX_LEN) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    // Try to split at a newline near the limit
    let cut = TG_MAX_LEN
    if (remaining.length > TG_MAX_LEN) {
      const lastNewline = remaining.lastIndexOf('\n', TG_MAX_LEN)
      if (lastNewline > TG_MAX_LEN * 0.5) cut = lastNewline
    }
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trimStart()
  }
  return chunks
}

export async function startTelegram(token: string, allowedUsers: number[], broadcast: Broadcast) {
  const bot = new Bot(token)

  // Auth middleware — only respond to allowed users
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id
    if (allowedUsers.length > 0 && (!userId || !allowedUsers.includes(userId))) {
      log.warn(`[telegram] Rejected user ${userId}`)
      await ctx.reply('Not authorized.')
      return
    }
    await next()
  })

  // /start — greet
  bot.command('start', async (ctx) => {
    getOrCreateSession(ctx.chat.id, 'Telegram')
    await ctx.reply('eggbot online. Send me anything.')
  })

  // /new — fresh session
  bot.command('new', async (ctx) => {
    newSession(ctx.chat.id)
    await ctx.reply('Started a new conversation.')
  })

  // /status — show active session
  bot.command('status', async (ctx) => {
    const sessionId = chatSessions.get(ctx.chat.id)
    await ctx.reply(sessionId ? `Session: ${sessionId.slice(0, 8)}…` : 'No active session.')
  })

  // /run — trigger goal loop manually
  bot.command('run', async (ctx) => {
    await ctx.reply('Running goals now...')
    runGoals(broadcast)
  })

  // Handle all text messages
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id
    const userText = ctx.message.text
    const sessionId = getOrCreateSession(chatId, userText.slice(0, 60))

    // Show typing indicator
    await ctx.replyWithChatAction('typing')
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {})
    }, 4000)

    // Save user message
    messages.insert({
      id: randomUUID(),
      session_id: sessionId,
      role: 'user',
      content: userText,
      agent_id: null,
      agent_name: null,
      metadata: JSON.stringify({ source: 'telegram', chat_id: chatId }),
    })

    try {
      const emit = (event: AgentEvent) => {
        broadcast(sessionId, { type: 'agent_event', event })
      }

      const orchestrator = new Orchestrator(sessionId, emit)
      const result = await orchestrator.handleMessage(userText)

      // Save assistant message
      messages.insert({
        id: randomUUID(),
        session_id: sessionId,
        role: 'assistant',
        content: result,
        agent_id: null,
        agent_name: 'boss',
        metadata: JSON.stringify({ source: 'telegram' }),
      })

      // Auto-rename session with a short title on first message
      const isFirst = messages.list(sessionId).filter(m => m.role === 'user').length <= 1
      if (isFirst) {
        chat('fast', [
          { role: 'user', content: `Summarize this conversation's goal as a short title (4-6 words, no punctuation, no quotes):\nUser: ${userText}\nAssistant: ${result.slice(0, 300)}` }
        ]).then(({ content: title }) => {
          const clean = title.trim().replace(/^["']|["']$/g, '').slice(0, 60)
          sessions.updateTitle(sessionId, clean)
          broadcast(sessionId, { type: 'session_renamed', sessionId, title: clean })
        }).catch(() => {})
      }

      // Send response (split if needed)
      clearInterval(typingInterval)
      const chunks = splitMessage(result || '(done)')
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() =>
          // Fallback to plain text if Markdown parse fails
          ctx.reply(chunk)
        )
      }

      broadcast(sessionId, {
        type: 'message',
        message: { role: 'assistant', content: result, agent_name: 'boss' },
      })
    } catch (err) {
      clearInterval(typingInterval)
      const msg = err instanceof Error ? err.message : String(err)
      log.error('[telegram] Error handling message', msg)
      await ctx.reply(`Error: ${msg}`)
    }
  })

  bot.catch((err) => {
    log.error('[telegram] Bot error', err.message)
  })

  await bot.start({ drop_pending_updates: true })
  log.info('[telegram] Bot started')
}
