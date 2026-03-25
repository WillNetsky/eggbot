// eggbot WebUI

const WS_URL = `ws://${location.host}/ws`

let ws = null
let currentSessionId = null
let isRunning = false

// DOM refs
const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('input')
const sendBtn = document.getElementById('send-btn')
const abortBtn = document.getElementById('abort-btn')
const sessionsList = document.getElementById('sessions-list')
const sessionTitle = document.getElementById('session-title')
const newChatBtn = document.getElementById('new-chat-btn')
const activityPanel = document.getElementById('activity-panel')
const activityLog = document.getElementById('activity-log')
const activityBtn = document.getElementById('activity-btn')
const activityDot = document.getElementById('activity-dot')
const activityLabel = document.getElementById('activity-label')

// Per-agent activity state
const actAgents = new Map() // agentId -> { thinkingEl, pendingToolEl }

// Connect WebSocket
function connect() {
  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', session_id: currentSessionId }))
  }

  ws.onmessage = (e) => {
    handleWsMessage(JSON.parse(e.data))
  }

  ws.onclose = () => setTimeout(connect, 2000)
  ws.onerror = () => {}
}

function handleWsMessage(data) {
  switch (data.type) {
    case 'joined':
      currentSessionId = data.session_id
      messagesEl.innerHTML = ''
      activityLog.innerHTML = ''
      actAgents.clear()
      for (const msg of data.messages) renderMessage(msg)
      scrollToBottom()
      loadSessions()
      break

    case 'message':
      renderMessage(data.message)
      scrollToBottom()
      if (data.message.role === 'assistant') {
        setRunning(false)
        loadTodos()
      }
      break

    case 'agent_event':
      handleAgentEvent(data.event)
      break

    case 'session_renamed': {
      const item = [...sessionsList.querySelectorAll('.session-item')].find(
        el => el.dataset.sessionId === data.sessionId
      )
      if (item) item.textContent = data.title
      if (data.sessionId === currentSessionId) sessionTitle.textContent = data.title
      break
    }

    case 'aborted':
      setRunning(false)
      appendActivityNote('— aborted —', 'var(--red)')
      break

    case 'error':
      setRunning(false)
      appendActivityNote(`error: ${data.message}`, 'var(--red)')
      break
  }
}

// ─── Activity panel ───────────────────────────────────────────────────────────

const TOOL_ICONS = {
  bash: '⚡', read_file: '📖', write_file: '✏️', list_dir: '📁',
  fetch_url: '🌐', spawn_agent: '🤖', wait_for_agents: '⏳',
  brain_write: '🧠', brain_read: '🧠', brain_search: '🔍', brain_list: '📋', brain_daily: '📅',
  set_session_goal: '🎯',
}

function getOrCreateAgent(agentId, agentName) {
  if (actAgents.has(agentId)) return actAgents.get(agentId)

  // Agent header
  const startEl = document.createElement('div')
  startEl.className = 'act-agent-start'
  startEl.textContent = agentName
  activityLog.appendChild(startEl)

  // Thinking block
  const thinkingEl = document.createElement('div')
  thinkingEl.className = 'act-thinking'
  activityLog.appendChild(thinkingEl)

  const agent = { thinkingEl, pendingToolEl: null }
  actAgents.set(agentId, agent)
  return agent
}

function handleAgentEvent(event) {
  const { type, agentId, agentName } = event

  switch (type) {
    case 'thinking': {
      const agent = getOrCreateAgent(agentId, agentName)
      const cursor = agent.thinkingEl.querySelector('.cursor')
      if (cursor) cursor.remove()
      agent.thinkingEl.appendChild(document.createTextNode(event.delta))
      const cur = document.createElement('span')
      cur.className = 'cursor'
      agent.thinkingEl.appendChild(cur)
      activityScrollToBottom()
      break
    }

    case 'tool_call': {
      const agent = getOrCreateAgent(agentId, agentName)

      // Remove cursor from thinking
      const cursor = agent.thinkingEl.querySelector('.cursor')
      if (cursor) cursor.remove()

      // Build args preview
      let argsLine = ''
      const a = event.args
      if (event.tool === 'bash' && a.command) {
        argsLine = `$ ${a.command.length > 200 ? a.command.slice(0, 197) + '…' : a.command}`
      } else if (a.path) {
        argsLine = a.path
      } else if (a.url) {
        argsLine = a.url
      } else if (a.query) {
        argsLine = a.query
      } else if (a.name) {
        argsLine = `${a.name}${a.model ? ' (' + a.model + ')' : ''}`
      } else {
        const entries = Object.entries(a)
        argsLine = entries.map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join('  ')
      }

      const toolEl = document.createElement('div')
      toolEl.className = 'act-tool'
      toolEl.innerHTML = `
        <div class="act-tool-header">
          <span>${TOOL_ICONS[event.tool] ?? '🔧'}</span>
          <span>${escapeHtml(event.tool)}</span>
          <span class="act-tool-status running">running</span>
        </div>
        <div class="act-tool-args">${escapeHtml(argsLine)}</div>
        <div class="act-tool-result collapsed"></div>
      `
      // Toggle result on click
      toolEl.querySelector('.act-tool-header').addEventListener('click', () => {
        toolEl.querySelector('.act-tool-result').classList.toggle('collapsed')
      })

      activityLog.appendChild(toolEl)
      agent.pendingToolEl = toolEl
      activityScrollToBottom()
      break
    }

    case 'tool_result': {
      const agent = actAgents.get(agentId)
      if (!agent?.pendingToolEl) break
      const toolEl = agent.pendingToolEl
      const statusEl = toolEl.querySelector('.act-tool-status')
      const resultEl = toolEl.querySelector('.act-tool-result')

      statusEl.textContent = event.success ? '✓' : '✗'
      statusEl.className = `act-tool-status ${event.success ? 'ok' : 'err'}`

      const out = event.output ?? ''
      resultEl.textContent = out.length > 800 ? out.slice(0, 797) + '…' : out
      resultEl.className = `act-tool-result${event.success ? '' : ' err'}`
      // Auto-expand errors
      if (!event.success) resultEl.classList.remove('collapsed')

      agent.pendingToolEl = null
      activityScrollToBottom()
      break
    }

    case 'spawn': {
      const el = document.createElement('div')
      el.className = 'act-spawn'
      el.textContent = `↳ spawning ${event.childName}`
      activityLog.appendChild(el)
      activityScrollToBottom()
      break
    }

    case 'injected': {
      const el = document.createElement('div')
      el.className = 'act-inject'
      el.textContent = `↩ ${event.message}`
      activityLog.appendChild(el)
      activityScrollToBottom()
      break
    }

    case 'done': {
      const agent = actAgents.get(agentId)
      if (agent) {
        const cursor = agent.thinkingEl.querySelector('.cursor')
        if (cursor) cursor.remove()
        const doneEl = document.createElement('div')
        doneEl.className = 'act-done'
        doneEl.textContent = `✓ ${agentName} done`
        activityLog.appendChild(doneEl)
        activityScrollToBottom()
      }
      break
    }

    case 'error': {
      appendActivityNote(`✗ ${agentName}: ${event.message}`, 'var(--red)')
      break
    }
  }
}

function appendActivityNote(text, color = 'var(--text-muted)') {
  const el = document.createElement('div')
  el.style.cssText = `padding:4px 12px;font-size:11px;color:${color};`
  el.textContent = text
  activityLog.appendChild(el)
  activityScrollToBottom()
}

function activityScrollToBottom() {
  activityLog.scrollTop = activityLog.scrollHeight
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function renderMessage(msg) {
  if (msg.metadata) {
    try {
      const meta = JSON.parse(msg.metadata)
      if (meta.type === 'heartbeat_pulse' || meta.type === 'goal_run') return
    } catch {}
  }

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
  el.className = 'system-msg'
  el.style.color = isError ? 'var(--red)' : 'var(--text-muted)'
  el.textContent = text
  messagesEl.appendChild(el)
  scrollToBottom()
}

function formatContent(text) {
  return escapeHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
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

// ─── Running state ────────────────────────────────────────────────────────────

function setRunning(running) {
  isRunning = running
  abortBtn.classList.toggle('hidden', !running)
  activityDot.className = `activity-dot ${running ? 'running' : 'idle'}`
  activityLabel.textContent = running ? 'running' : 'idle'
  if (!running) actAgents.clear()
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

async function loadSessions() {
  const res = await fetch('/api/sessions')
  const list = await res.json()
  sessionsList.innerHTML = ''
  for (const s of list) {
    const el = document.createElement('div')
    el.className = `session-item${s.id === currentSessionId ? ' active' : ''}`
    el.dataset.sessionId = s.id
    el.textContent = s.title ?? 'New conversation'
    el.addEventListener('click', () => switchSession(s.id))
    sessionsList.appendChild(el)
  }
  // Update title
  const current = list.find(s => s.id === currentSessionId)
  if (current) sessionTitle.textContent = current.title ?? 'New conversation'
}

function switchSession(id) {
  if (id === currentSessionId) return
  currentSessionId = id
  messagesEl.innerHTML = ''
  activityLog.innerHTML = ''
  actAgents.clear()
  setRunning(false)
  ws.send(JSON.stringify({ type: 'join', session_id: id }))
}

function randomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function newChat() {
  const newId = randomUUID()
  currentSessionId = newId
  messagesEl.innerHTML = ''
  activityLog.innerHTML = ''
  actAgents.clear()
  setRunning(false)
  sessionTitle.textContent = 'New conversation'
  ws.send(JSON.stringify({ type: 'join', session_id: newId }))
}

// ─── Send message ─────────────────────────────────────────────────────────────

function sendMessage() {
  const content = inputEl.value.trim()
  if (!content) return
  inputEl.value = ''
  inputEl.style.height = 'auto'
  if (!isRunning) {
    setRunning(true)
    activityLog.innerHTML = ''
    actAgents.clear()
  }
  ws.send(JSON.stringify({ type: 'message', content }))
}

// ─── Todo panel ───────────────────────────────────────────────────────────────

const todoList = document.getElementById('todo-list')
const todoAddBtn = document.getElementById('todo-add-btn')
const todoAddForm = document.getElementById('todo-add-form')
const todoInput = document.getElementById('todo-input')

async function loadTodos() {
  const res = await fetch('/api/todos')
  const items = await res.json()
  renderTodos(items)
}

function renderTodos(items) {
  todoList.innerHTML = ''
  const active = items.filter(t => t.status !== 'done')
  const done = items.filter(t => t.status === 'done')
  for (const t of [...active, ...done]) {
    todoList.appendChild(makeTodoEl(t))
  }
}

function makeTodoEl(t) {
  const el = document.createElement('div')
  el.className = `todo-item ${t.status}`
  el.dataset.id = t.id

  const check = document.createElement('div')
  check.className = 'todo-check'
  if (t.status === 'done') check.textContent = '✓'
  check.title = t.status === 'done' ? 'Mark todo' : 'Mark done'
  check.addEventListener('click', async () => {
    const newStatus = t.status === 'done' ? 'todo' : 'done'
    await fetch(`/api/todos/${t.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    })
    loadTodos()
  })

  const text = document.createElement('div')
  text.className = 'todo-text'
  text.textContent = t.title
  if (t.notes) text.title = t.notes

  const del = document.createElement('button')
  del.className = 'todo-delete'
  del.textContent = '×'
  del.title = 'Delete'
  del.addEventListener('click', async () => {
    await fetch(`/api/todos/${t.id}`, { method: 'DELETE' })
    loadTodos()
  })

  if (t.priority) {
    const pri = document.createElement('span')
    pri.className = 'todo-priority'
    pri.textContent = '⚡'
    el.appendChild(check)
    el.appendChild(text)
    el.appendChild(pri)
    el.appendChild(del)
  } else {
    el.appendChild(check)
    el.appendChild(text)
    el.appendChild(del)
  }

  return el
}

todoAddBtn.addEventListener('click', () => {
  todoAddForm.classList.toggle('hidden')
  if (!todoAddForm.classList.contains('hidden')) todoInput.focus()
})

todoInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const title = todoInput.value.trim()
    if (!title) return
    await fetch('/api/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    todoInput.value = ''
    todoAddForm.classList.add('hidden')
    loadTodos()
  } else if (e.key === 'Escape') {
    todoInput.value = ''
    todoAddForm.classList.add('hidden')
  }
})

// ─── Activity panel toggle ────────────────────────────────────────────────────

activityBtn.addEventListener('click', () => {
  const hidden = activityPanel.classList.toggle('hidden')
  activityBtn.classList.toggle('active', !hidden)
})

// ─── Event listeners ──────────────────────────────────────────────────────────

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

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px'
})

// Start
connect()
loadTodos()
// Refresh todos periodically (agent may update them autonomously)
setInterval(loadTodos, 30000)
