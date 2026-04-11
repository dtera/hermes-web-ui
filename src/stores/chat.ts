import { defineStore } from 'pinia'
import { ref } from 'vue'
import { startRun, streamRunEvents, type ChatMessage, type RunEvent } from '@/api/chat'
import { useAppStore } from './app'

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: File
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  toolName?: string
  toolPreview?: string
  toolStatus?: 'running' | 'done' | 'error'
  isStreaming?: boolean
  attachments?: Attachment[]
}

interface Session {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const res = await fetch('/__upload', { method: 'POST', body: formData })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

const SESSIONS_KEY = 'hermes_chat_sessions'
const ACTIVE_SESSION_KEY = 'hermes_active_session'

function loadSessions(): Session[] {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')
  } catch {
    return []
  }
}

function saveSessions(sessions: Session[]) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
}

function loadActiveSessionId(): string | null {
  return localStorage.getItem(ACTIVE_SESSION_KEY)
}

export const useChatStore = defineStore('chat', () => {
  const appStore = useAppStore()
  const sessions = ref<Session[]>(loadSessions())
  const activeSessionId = ref<string | null>(loadActiveSessionId())
  const isStreaming = ref(false)
  const abortController = ref<AbortController | null>(null)

  const activeSession = ref<Session | null>(
    sessions.value.find(s => s.id === activeSessionId.value) || null,
  )

  const messages = ref<Message[]>(activeSession.value?.messages || [])

  function createSession(): Session {
    const session: Session = {
      id: uid(),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    saveSessions(sessions.value)
    return session
  }

  function switchSession(sessionId: string) {
    activeSessionId.value = sessionId
    localStorage.setItem(ACTIVE_SESSION_KEY, sessionId)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null
    messages.value = activeSession.value ? [...activeSession.value.messages] : []
  }

  function newChat() {
    if (isStreaming.value) return
    const session = createSession()
    switchSession(session.id)
  }

  function deleteSession(sessionId: string) {
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    saveSessions(sessions.value)
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
  }

  function stripNonSerializable(msgs: Message[]): Message[] {
    return msgs.map(m => ({
      ...m,
      attachments: m.attachments?.map(a => ({ ...a, file: undefined, url: '' })),
    }))
  }

  function persistMessages() {
    if (!activeSession.value || !appStore.sessionPersistence) return
    activeSession.value.messages = stripNonSerializable(messages.value)
    activeSession.value.updatedAt = Date.now()

    if (activeSession.value.title === 'New Chat') {
      const firstUser = messages.value.find(m => m.role === 'user')
      if (firstUser) {
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        activeSession.value.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }

    const idx = sessions.value.findIndex(s => s.id === activeSession.value!.id)
    if (idx !== -1) sessions.value[idx] = activeSession.value
    saveSessions(sessions.value)
  }

  function addMessage(msg: Message) {
    messages.value.push(msg)
  }

  function updateMessage(id: string, update: Partial<Message>) {
    const idx = messages.value.findIndex(m => m.id === id)
    if (idx !== -1) {
      messages.value[idx] = { ...messages.value[idx], ...update }
    }
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if ((!content.trim() && !(attachments && attachments.length > 0)) || isStreaming.value) return

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }
    addMessage(userMsg)
    persistMessages()

    isStreaming.value = true

    try {
      // Build conversation history from past messages
      const history: ChatMessage[] = messages.value
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
        .map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }))

      // Upload attachments and build input with file paths
      let inputText = content.trim()
      if (attachments && attachments.length > 0) {
        const uploaded = await uploadFiles(attachments)
        const pathParts = uploaded.map(f => `[File: ${f.name}](${f.path})`)
        inputText = inputText ? inputText + '\n\n' + pathParts.join('\n') : pathParts.join('\n')
      }

      const run = await startRun({
        input: inputText,
        conversation_history: history,
        session_id: activeSession.value?.id,
      })

      const runId = (run as any).run_id || (run as any).id
      if (!runId) {
        addMessage({
          id: uid(),
          role: 'system',
          content: `Error: startRun returned no run ID. Response: ${JSON.stringify(run)}`,
          timestamp: Date.now(),
        })
        isStreaming.value = false
        persistMessages()
        return
      }

      // Listen to SSE events
      abortController.value = streamRunEvents(
        runId,
        // onEvent
        (evt: RunEvent) => {
          switch (evt.event) {
            case 'run.started':
              // run started, nothing to render yet
              break

            case 'message.delta': {
              // Find or create the assistant message
              const last = messages.value[messages.value.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                last.content += evt.delta || ''
              } else {
                addMessage({
                  id: uid(),
                  role: 'assistant',
                  content: evt.delta || '',
                  timestamp: Date.now(),
                  isStreaming: true,
                })
              }
              break
            }

            case 'tool.started': {
              // Close any streaming assistant message first
              const last = messages.value[messages.value.length - 1]
              if (last?.isStreaming) {
                updateMessage(last.id, { isStreaming: false })
              }
              // Add tool message
              addMessage({
                id: uid(),
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolName: evt.tool || evt.name,
                toolPreview: evt.preview,
                toolStatus: 'running',
              })
              break
            }

            case 'tool.completed': {
              // Find the running tool message and mark done
              const toolMsgs = messages.value.filter(
                m => m.role === 'tool' && m.toolStatus === 'running',
              )
              if (toolMsgs.length > 0) {
                const last = toolMsgs[toolMsgs.length - 1]
                updateMessage(last.id, { toolStatus: 'done' })
              }
              break
            }

            case 'run.completed':
              // Close any streaming message
              const lastMsg = messages.value[messages.value.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(lastMsg.id, { isStreaming: false })
              }
              isStreaming.value = false
              abortController.value = null
              persistMessages()
              break

            case 'run.failed':
              // Mark error
              const lastErr = messages.value[messages.value.length - 1]
              if (lastErr?.isStreaming) {
                updateMessage(lastErr.id, {
                  isStreaming: false,
                  content: evt.error ? `Error: ${evt.error}` : 'Run failed',
                  role: 'system',
                })
              } else {
                addMessage({
                  id: uid(),
                  role: 'system',
                  content: evt.error ? `Error: ${evt.error}` : 'Run failed',
                  timestamp: Date.now(),
                })
              }
              // Mark any running tools as error
              messages.value.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  messages.value[i] = { ...m, toolStatus: 'error' }
                }
              })
              isStreaming.value = false
              abortController.value = null
              persistMessages()
              break
          }
        },
        // onDone
        () => {
          const last = messages.value[messages.value.length - 1]
          if (last?.isStreaming) {
            updateMessage(last.id, { isStreaming: false })
          }
          isStreaming.value = false
          abortController.value = null
          persistMessages()
        },
        // onError
        (err) => {
          const last = messages.value[messages.value.length - 1]
          if (last?.isStreaming) {
            updateMessage(last.id, {
              isStreaming: false,
              content: `Error: ${err.message}`,
              role: 'system',
            })
          } else {
            addMessage({
              id: uid(),
              role: 'system',
              content: `Error: ${err.message}`,
              timestamp: Date.now(),
            })
          }
          isStreaming.value = false
          abortController.value = null
          persistMessages()
        },
      )
    } catch (err: any) {
      addMessage({
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
      isStreaming.value = false
      abortController.value = null
      persistMessages()
    }
  }

  function stopStreaming() {
    abortController.value?.abort()
    isStreaming.value = false
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg?.isStreaming) {
      updateMessage(lastMsg.id, { isStreaming: false })
    }
    abortController.value = null
  }

  if (sessions.value.length === 0) {
    const session = createSession()
    switchSession(session.id)
  } else if (!activeSession.value) {
    switchSession(sessions.value[0].id)
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    messages,
    isStreaming,
    newChat,
    switchSession,
    deleteSession,
    sendMessage,
    stopStreaming,
  }
})
