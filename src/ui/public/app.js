// eggbot WebUI

const WS_URL = `ws://${location.host}/ws`

let ws = null
let currentSessionId = null
let isRunning = false

// Agent color palette (cycles)
const AGENT_COLORS = ['#5ce8e8', '#ff9f43', '#3ddc84', '#ff6eb4', '#a29bfe', '#fd79a8', '#fdcb6e', '#e17055']
const agentColors = new Map()
let colorIndex = 0

function getAgentColor(name) {
  if (!agentColors.has(name)) {
    agentColors.set(name, AGENT_COLORS[colorIndex % AGENT_COLORS.length])
    colorIndex++
  }
  return agentColors.get(name)
}

// DOM refs
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send-btn')
const abortBtn = document.getElementById('abort-btn')
const sessionsList = document.getElementById('sessions-list')
const sessionTitle = document.getElementById('session-title')
const newChatBtn = document.getElementById('new-chat-btn')

// Active agent blocks during a run
const agentBlocks = new Map() // agentId -> { blockEl, bodyEl, thinkingEl, status }

// Connect WebSocket
function connect() {
  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    console.log('Connected to eggbot')
    // Join or create session
    ws.send(JSON.stringify({ type: 'join', session_id: currentSessionId }))
  }

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data)
    handleWsMessage(data)
  }

  ws.onclose = () => {
    console.log('Disconnected, reconnecting in 2s...')
    setTimeout(connect, 2000)
  }

  ws.onerror = (err) => {
    console.error('WS error:', err)
  }
}

function handleWsMessage(data) {
  switch (data.type) {
    case 'joined':
      currentSessionId = data.session_id
      // Render existing messages
      messagesEl.innerHTML = ''
      agentBlocks.clear()
      agentColors.clear()
      colorIndex = 0
      for (const msg of data.messages) {
        renderMessage(msg)
      }
      scrollToBottom()
      loadSessions()
      break

    case 'message':
      renderMessage(data.message)
      scrollToBottom()
      if (data.message.role === 'assistant') {
        setRunning(false)
      }
      break

    case 'agent_event':
      handleAgentEvent(data.event)
      scrollToBottom()
      break

    case 'aborted':
      setRunning(false)
      appendSystemMessage('Run aborted.')
      break

    case 'error':
      setRunning(false)
      appendSystemMessage(`Error: ${data.message}`, true)
      break
  }
}

function handleAgentEvent(event) {
  const { type, agentId, agentName } = event

  switch (type) {
    case 'thinking': {
      let block = agentBlocks.get(agentId)
      if (!block) {
        block = createAgentBlock(agentId, agentName)
      }
      // Append text to thinking stream
      const cursor = block.thinkingEl.querySelector('.cursor')
      if (cursor) cursor.remove()

      block.thinkingEl.appendChild(document.createTextNode(event.delta))

      // Re-add cursor
      const cur = document.createElement('span')
      cur.className = 'cursor'
      block.thinkingEl.appendChild(cur)
      break
    }

    case 'tool_call': {
      let block = agentBlocks.get(agentId)
      if (!block) block = createAgentBlock(agentId, agentName)

      // Remove cursor if present
      const cursor = block.thinkingEl.querySelector('.cursor')
      if (cursor) cursor.remove()

      const toolEl = createToolCall(event.tool, event.args)
      block.bodyEl.appendChild(toolEl)
      block.pendingToolEl = toolEl
      break
    }

    case 'tool_result': {
      const block = agentBlocks.get(agentId)
      if (!block?.pendingToolEl) break

      const statusEl = block.pendingToolEl.querySelector('.tool-status')
      const resultEl = block.pendingToolEl.querySelector('.tool-result')

      if (statusEl) {
        statusEl.textContent = event.success ? '✓' : '✗'
        statusEl.className = `tool-status ${event.success ? 'ok' : 'err'}`
      }
      if (resultEl) {
        resultEl.textContent = event.output
        resultEl.className = `tool-result ${event.success ? 'ok' : 'err'}`
      }

      block.pendingToolEl = null
      break
    }

    case 'spawn': {
      const block = agentBlocks.get(agentId)
      if (block) {
        const spawnEl = document.createElement('div')
        spawnEl.className = 'spawn-event'
        spawnEl.innerHTML = `↳ spawning <span style="color:${getAgentColor(event.childName)}">${event.childName}</span>`
        block.bodyEl.appendChild(spawnEl)
      }
      break
    }

    case 'done': {
      const block = agentBlocks.get(agentId)
      if (block) {
        const cursor = block.thinkingEl.querySelector('.cursor')
        if (cursor) cursor.remove()
        block.dotEl.className = 'agent-dot done'
        block.status = 'done'
      }
      break
    }

    case 'error': {
      const block = agentBlocks.get(agentId)
      if (block) {
        block.dotEl.className = 'agent-dot error'
        block.status = 'error'
        const errEl = document.createElement('div')
        errEl.style.color = 'var(--red)'
        errEl.textContent = `Error: ${event.message}`
        block.bodyEl.appendChild(errEl)
      }
      break
    }
  }
}

function createAgentBlock(agentId, agentName) {
  const color = getAgentColor(agentName)

  const blockEl = document.createElement('div')
  blockEl.className = 'agent-block'

  const header = document.createElement('div')
  header.className = 'agent-header'
  header.innerHTML = `
    <span class="agent-dot running"></span>
    <span class="agent-name" style="color:${color}">${agentName}</span>
    <span class="agent-toggle" style="font-size:10px;color:var(--text-muted);margin-left:auto">▾</span>
  `

  const bodyEl = document.createElement('div')
  bodyEl.className = 'agent-body'

  const thinkingEl = document.createElement('div')
  thinkingEl.className = 'thinking-stream'
  bodyEl.appendChild(thinkingEl)

  // Toggle collapse
  header.addEventListener('click', () => {
    const isCollapsed = bodyEl.classList.toggle('collapsed')
    header.querySelector('.agent-toggle').textContent = isCollapsed ? '▸' : '▾'
  })

  blockEl.appendChild(header)
  blockEl.appendChild(bodyEl)
  messagesEl.appendChild(blockEl)

  const dotEl = header.querySelector('.agent-dot')
  const block = { blockEl, bodyEl, thinkingEl, dotEl, status: 'running', pendingToolEl: null }
  agentBlocks.set(agentId, block)
  return block
}

function createToolCall(toolName, args) {
  const el = document.createElement('div')
  el.className = 'tool-call'

  const toolIcons = {
    bash: '⚡',
    read_file: '📖',
    write_file: '✏️',
    list_dir: '📁',
    fetch_url: '🌐',
    spawn_agent: '🤖',
    wait_for_agents: '⏳',
  }

  const icon = toolIcons[toolName] ?? '🔧'

  // Format args for display
  let argsDisplay = ''
  if (toolName === 'bash' && args.command) {
    argsDisplay = `$ ${args.command.length > 120 ? args.command.slice(0, 117) + '...' : args.command}`
  } else if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'list_dir') {
    argsDisplay = args.path ?? ''
  } else if (toolName === 'fetch_url') {
    argsDisplay = args.url ?? ''
  } else if (toolName === 'spawn_agent') {
    argsDisplay = `${args.name} (${args.model})`
  } else {
    argsDisplay = JSON.stringify(args)
  }

  el.innerHTML = `
    <div class="tool-call-header">
      <span class="tool-icon">${icon}</span>
      <span class="tool-name">${toolName}</span>
      <span class="tool-status running" style="color:var(--yellow)">...</span>
    </div>
    <div class="tool-body collapsed">
      <div class="tool-args">${escapeHtml(argsDisplay)}</div>
      <div class="tool-result"></div>
    </div>
  `

  // Toggle body on header click
  const header = el.querySelector('.tool-call-header')
  const body = el.querySelector('.tool-body')
  header.addEventListener('click', () => body.classList.toggle('collapsed'))

  return el
}

function renderMessage(msg) {
  const el = document.createElement('div')
  el.className = `message ${msg.role}`

  const meta = document.createElement('div')
  meta.className = 'message-meta'
  meta.textContent = msg.role === 'user' ? 'you' : (msg.agent_name ?? 'eggbot')

  const bubble = document.createElement('div')
  bubble.className = 'message-bubble'
  bubble.innerHTML = formatContent(msg.content)

  el.appendChild(meta)
  el.appendChild(bubble)
  messagesEl.appendChild(el)
}

function appendSystemMessage(text, isError = false) {
  const el = document.createElement('div')
  el.style.cssText = `text-align:center;font-size:11px;color:${isError ? 'var(--red)' : 'var(--text-muted)'};padding:8px 0;`
  el.textContent = text
  messagesEl.appendChild(el)
  scrollToBottom()
}

function formatContent(text) {
  // Basic markdown-ish formatting
  return escapeHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '\n')
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function setRunning(running) {
  isRunning = running
  sendBtn.disabled = running
  abortBtn.classList.toggle('hidden', !running)
  if (!running) {
    agentBlocks.clear()
  }
}

async function loadSessions() {
  const res = await fetch('/api/sessions')
  const list = await res.json()
  sessionsList.innerHTML = ''
  for (const s of list) {
    const el = document.createElement('div')
    el.className = `session-item${s.id === currentSessionId ? ' active' : ''}`
    el.textContent = s.title ?? 'New conversation'
    el.addEventListener('click', () => switchSession(s.id))
    sessionsList.appendChild(el)
  }
}

function switchSession(id) {
  if (id === currentSessionId) return
  currentSessionId = id
  messagesEl.innerHTML = ''
  agentBlocks.clear()
  agentColors.clear()
  colorIndex = 0
  setRunning(false)
  ws.send(JSON.stringify({ type: 'join', session_id: id }))
}

function newChat() {
  currentSessionId = null
  messagesEl.innerHTML = ''
  agentBlocks.clear()
  agentColors.clear()
  colorIndex = 0
  setRunning(false)
  ws.send(JSON.stringify({ type: 'join', session_id: null }))
}

function sendMessage() {
  const content = inputEl.value.trim()
  if (!content || isRunning) return

  inputEl.value = ''
  inputEl.style.height = 'auto'
  setRunning(true)
  agentBlocks.clear()

  ws.send(JSON.stringify({ type: 'message', content }))
}

// Event listeners
sendBtn.addEventListener('click', sendMessage)
newChatBtn.addEventListener('click', newChat)
abortBtn.addEventListener('click', () => {
  ws.send(JSON.stringify({ type: 'abort' }))
})

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
})

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px'
})

// Start
connect()
