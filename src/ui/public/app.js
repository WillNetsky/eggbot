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
const teamPanel = document.getElementById('team-panel')
const teamFloor = document.getElementById('team-floor')
const teamBtn = document.getElementById('team-btn')
const statusDot = document.getElementById('status-dot')
const statusLabel = document.getElementById('status-label')
const agentCountEl = document.getElementById('agent-count')

// ─── Agent state ────────────────────────────────────────────────────────────

const agents = new Map()      // agentId -> { card, thinkingEl, bodyEl, pendingToolEl, name, model }
const agentParents = new Map() // childId -> parentId

const ROLE_COLORS = {
  boss: '#f59e0b',
  orchestrator: '#f59e0b',
  coder: '#06b6d4',
  fast: '#10b981',
  reasoning: '#a78bfa',
}

const TOOL_ICONS = {
  bash: '⚡', read_file: '📄', write_file: '✏️', list_dir: '📁',
  fetch_url: '🌐', spawn_agent: '🤖', wait_for_agents: '⏳',
  brain_write: '🧠', brain_read: '🧠', brain_search: '🔍',
  brain_list: '📋', brain_daily: '📅', set_session_goal: '🎯',
  todo_add: '☑️', todo_update: '☑️', todo_list: '☑️',
}

function inferRole(name, model) {
  const n = (name || '').toLowerCase()
  if (n === 'boss') return 'boss'
  const m = (model || '').toLowerCase()
  if (m.includes('coder') || m.includes('llama3.1') || m.includes('codestral')) return 'coder'
  if (m.includes('llama3.2') || m.includes('gemma3:4b') || m.includes('qwen2.5:7b')) return 'fast'
  if (m.includes('deepseek-r1') || m.includes('phi4')) return 'reasoning'
  if (n.includes('coder') || n.includes('writer') || n.includes('script')) return 'coder'
  if (n.includes('research') || n.includes('analy')) return 'reasoning'
  return 'coder'
}

function getRoleColor(role) {
  return ROLE_COLORS[role] || '#6366f1'
}

function getInitial(name) {
  if (!name) return '?'
  if (name === 'boss') return 'B'
  return name.charAt(0).toUpperCase()
}

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(WS_URL)
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', session_id: currentSessionId }))
  ws.onmessage = (e) => handleWsMessage(JSON.parse(e.data))
  ws.onclose = () => setTimeout(connect, 2000)
  ws.onerror = () => {}
}

function handleWsMessage(data) {
  switch (data.type) {
    case 'joined':
      currentSessionId = data.session_id
      messagesEl.innerHTML = ''
      clearTeam()
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
      addTeamNote('Aborted', 'var(--red)')
      break

    case 'error':
      setRunning(false)
      addTeamNote(`Error: ${data.message}`, 'var(--red)')
      break
  }
}

// ─── Team Panel (Agent Cards) ───────────────────────────────────────────────

function getOrCreateAgent(agentId, agentName, model) {
  if (agents.has(agentId)) return agents.get(agentId)

  const role = inferRole(agentName, model)
  const color = getRoleColor(role)
  const isChild = agentParents.has(agentId)

  // Create card
  const card = document.createElement('div')
  card.className = `agent-card${isChild ? ' child' : ''}`
  card.style.setProperty('--agent-color', color)

  // Header
  const header = document.createElement('div')
  header.className = 'agent-card-header'

  const avatar = document.createElement('div')
  avatar.className = 'agent-avatar'
  avatar.textContent = getInitial(agentName)

  const info = document.createElement('div')
  info.className = 'agent-info'

  const nameEl = document.createElement('span')
  nameEl.className = 'agent-card-name'
  nameEl.textContent = agentName

  const modelEl = document.createElement('span')
  modelEl.className = 'agent-card-model'
  modelEl.textContent = model || ''

  info.appendChild(nameEl)
  info.appendChild(modelEl)

  const statusBadge = document.createElement('span')
  statusBadge.className = 'agent-status-badge working'
  statusBadge.textContent = 'working'

  header.appendChild(avatar)
  header.appendChild(info)
  header.appendChild(statusBadge)

  // Body
  const body = document.createElement('div')
  body.className = 'agent-card-body'

  const thinking = document.createElement('div')
  thinking.className = 'agent-thinking'

  body.appendChild(thinking)
  card.appendChild(header)
  card.appendChild(body)
  teamFloor.appendChild(card)

  const agent = {
    card, header, body, thinkingEl: thinking,
    statusBadge, pendingToolEl: null,
    name: agentName, model
  }
  agents.set(agentId, agent)
  updateAgentCount()
  return agent
}

function handleAgentEvent(event) {
  const { type, agentId, agentName, model } = event

  switch (type) {
    case 'thinking': {
      setRunning(true)
      const agent = getOrCreateAgent(agentId, agentName, model)
      const cursor = agent.thinkingEl.querySelector('.cursor')
      if (cursor) cursor.remove()
      agent.thinkingEl.appendChild(document.createTextNode(event.delta))
      const cur = document.createElement('span')
      cur.className = 'cursor'
      agent.thinkingEl.appendChild(cur)
      teamScrollToBottom()
      break
    }

    case 'tool_call': {
      const agent = getOrCreateAgent(agentId, agentName, model)

      // Remove cursor
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
      toolEl.className = 'agent-tool'

      const headerEl = document.createElement('div')
      headerEl.className = 'agent-tool-header'
      headerEl.innerHTML = `
        <span class="agent-tool-icon">${TOOL_ICONS[event.tool] ?? '🔧'}</span>
        <span class="agent-tool-name">${escapeHtml(event.tool)}</span>
        <span class="agent-tool-status running">running</span>
      `

      const argsEl = document.createElement('div')
      argsEl.className = 'agent-tool-args'
      argsEl.textContent = argsLine

      const resultEl = document.createElement('div')
      resultEl.className = 'agent-tool-result collapsed'

      headerEl.addEventListener('click', () => {
        resultEl.classList.toggle('collapsed')
      })

      toolEl.appendChild(headerEl)
      toolEl.appendChild(argsEl)
      toolEl.appendChild(resultEl)
      agent.body.appendChild(toolEl)
      agent.pendingToolEl = toolEl
      teamScrollToBottom()
      break
    }

    case 'tool_result': {
      const agent = agents.get(agentId)
      if (!agent?.pendingToolEl) break

      const toolEl = agent.pendingToolEl
      const statusEl = toolEl.querySelector('.agent-tool-status')
      const resultEl = toolEl.querySelector('.agent-tool-result')

      statusEl.textContent = event.success ? '✓' : '✗'
      statusEl.className = `agent-tool-status ${event.success ? 'ok' : 'err'}`

      const out = event.output ?? ''
      resultEl.textContent = out.length > 800 ? out.slice(0, 797) + '…' : out
      resultEl.className = `agent-tool-result${event.success ? '' : ' err'}`
      if (!event.success) resultEl.classList.remove('collapsed')

      agent.pendingToolEl = null
      teamScrollToBottom()
      break
    }

    case 'spawn': {
      agentParents.set(event.childId, agentId)

      const agent = agents.get(agentId)
      if (agent) {
        const spawnEl = document.createElement('div')
        spawnEl.className = 'agent-spawn'
        spawnEl.textContent = `spawning ${event.childName}`
        agent.body.appendChild(spawnEl)
      }
      teamScrollToBottom()
      break
    }

    case 'injected': {
      const el = document.createElement('div')
      el.className = 'agent-inject'
      el.textContent = `↩ ${event.message}`
      teamFloor.appendChild(el)
      teamScrollToBottom()
      break
    }

    case 'done': {
      const agent = agents.get(agentId)
      if (agent) {
        const cursor = agent.thinkingEl.querySelector('.cursor')
        if (cursor) cursor.remove()
        agent.statusBadge.textContent = 'done'
        agent.statusBadge.className = 'agent-status-badge done'
        agent.card.classList.add('completed')
      }
      updateAgentCount()
      teamScrollToBottom()
      break
    }

    case 'error': {
      const agent = agents.get(agentId)
      if (agent) {
        agent.statusBadge.textContent = 'error'
        agent.statusBadge.className = 'agent-status-badge error'
      }
      addTeamNote(`${agentName}: ${event.message}`, 'var(--red)')
      break
    }
  }
}

function clearTeam() {
  teamFloor.innerHTML = ''
  agents.clear()
  agentParents.clear()
  updateAgentCount()
}

function addTeamNote(text, color = 'var(--text-muted)') {
  const el = document.createElement('div')
  el.className = 'team-note'
  el.style.color = color
  el.textContent = text
  teamFloor.appendChild(el)
  teamScrollToBottom()
}

function updateAgentCount() {
  const active = [...agents.values()].filter(a => !a.card.classList.contains('completed')).length
  agentCountEl.textContent = active > 0 ? `${active} active` : ''
}

function teamScrollToBottom() {
  teamFloor.scrollTop = teamFloor.scrollHeight
}

// ─── Chat ───────────────────────────────────────────────────────────────────

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

// ─── Running state ──────────────────────────────────────────────────────────

function setRunning(running) {
  isRunning = running
  abortBtn.classList.toggle('hidden', !running)
  statusDot.className = `status-dot ${running ? 'running' : 'idle'}`
  statusLabel.textContent = running ? 'running' : 'idle'
  if (!running) {
    // Mark any remaining agents as done
    for (const agent of agents.values()) {
      if (!agent.card.classList.contains('completed')) {
        const cursor = agent.thinkingEl.querySelector('.cursor')
        if (cursor) cursor.remove()
      }
    }
  }
}

// ─── Sessions ───────────────────────────────────────────────────────────────

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
  const current = list.find(s => s.id === currentSessionId)
  if (current) sessionTitle.textContent = current.title ?? 'New conversation'
}

function switchSession(id) {
  if (id === currentSessionId) return
  currentSessionId = id
  messagesEl.innerHTML = ''
  clearTeam()
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
  clearTeam()
  setRunning(false)
  sessionTitle.textContent = 'New conversation'
  ws.send(JSON.stringify({ type: 'join', session_id: newId }))
}

// ─── Send message ───────────────────────────────────────────────────────────

function sendMessage() {
  const content = inputEl.value.trim()
  if (!content) return
  inputEl.value = ''
  inputEl.style.height = 'auto'
  if (!isRunning) {
    setRunning(true)
    clearTeam()
  }
  ws.send(JSON.stringify({ type: 'message', content }))
}

// ─── Todo panel ─────────────────────────────────────────────────────────────

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

  el.appendChild(check)
  el.appendChild(text)
  if (t.priority) {
    const pri = document.createElement('span')
    pri.className = 'todo-priority'
    pri.textContent = '⚡'
    el.appendChild(pri)
  }
  el.appendChild(del)
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

// ─── Team panel toggle ──────────────────────────────────────────────────────

teamBtn.addEventListener('click', () => {
  const hidden = teamPanel.classList.toggle('hidden')
  teamBtn.classList.toggle('active', !hidden)
})

// ─── Event listeners ────────────────────────────────────────────────────────

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

document.getElementById('team-clear').addEventListener('click', clearTeam)

// Start
connect()
loadTodos()
setInterval(loadTodos, 30000)
