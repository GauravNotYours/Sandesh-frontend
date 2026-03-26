import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/useAuth.js'
import { API_BASE, apiFetch } from '../lib/api.js'
import MessageBubble from '../components/MessageBubble.jsx'
import { io } from 'socket.io-client'

const MISSING_SOCKET_API_BASE_MESSAGE =
  'Missing VITE_API_BASE for production. Set it to your deployed backend URL before building the frontend.'
const MESSAGE_LIMIT = 100
const POLL_INTERVAL_MS = 3000

function toTimestamp(value) {
  const ms = new Date(value || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function mergeMessages(existing, incoming) {
  const merged = new Map(existing.map((message) => [message.id, message]))

  for (const message of incoming || []) {
    if (!message?.id) continue

    const previous = merged.get(message.id)
    merged.set(message.id, previous ? { ...previous, ...message } : message)
  }

  return Array.from(merged.values())
    .sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt))
    .slice(-MESSAGE_LIMIT)
}

function getLatestChangeCursor(messages) {
  return messages.reduce((latest, message) => {
    const createdAt = toTimestamp(message.createdAt)
    const deletedAt = toTimestamp(message.deletedAt)
    return Math.max(latest, createdAt, deletedAt)
  }, 0)
}

function getSocketAuthError(err) {
  const message = String(err?.message || '').trim()
  const lowered = message.toLowerCase()

  if (!message) return null
  if (lowered.includes('banned')) {
    return { status: 403, code: 'BANNED', message }
  }
  if (
    lowered.includes('missing token') ||
    lowered.includes('invalid token') ||
    lowered.includes('user not found') ||
    lowered.includes('unauthorized')
  ) {
    return { status: 401, message }
  }

  return null
}

export default function ChatPage() {
  const navigate = useNavigate()
  const { token, user, banned, logout, handleAuthError, refreshMe } = useAuth()

  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [error, setError] = useState('')
  const [realtimeMode, setRealtimeMode] = useState('polling')

  const messagesRef = useRef(null)
  const messagesEndRef = useRef(null)
  const socketRef = useRef(null)
  const latestCursorRef = useRef(0)

  useLayoutEffect(() => {
    const endEl = messagesEndRef.current
    if (!endEl) return

    requestAnimationFrame(() => {
      endEl.scrollIntoView({ block: 'end' })
    })
  }, [messages])

  useEffect(() => {
    latestCursorRef.current = getLatestChangeCursor(messages)
  }, [messages])

  function applyDeletedMessage(payload) {
    if (!payload?.id) return
    setMessages((prev) =>
      mergeMessages(prev, [
        {
          id: payload.id,
          isDeleted: true,
          deletedAt: payload.deletedAt || null,
          senderUsername: payload.senderUsername || null,
          text: '',
        },
      ]),
    )
    setReplyTo((prev) => (prev?.id === payload.id ? null : prev))
  }

  function applyIncomingMessages(incoming) {
    if (!incoming?.length) return

    setMessages((prev) => mergeMessages(prev, incoming))
    const deletedIds = new Set(incoming.filter((message) => message?.isDeleted).map((message) => message.id))
    if (deletedIds.size) {
      setReplyTo((prev) => (prev?.id && deletedIds.has(prev.id) ? null : prev))
    }
  }

  const fetchMessages = useCallback(async ({ sinceMs } = {}) => {
    const qs = sinceMs ? `?since=${sinceMs}` : ''
    const res = await apiFetch(`/api/chat/messages${qs}`, { token })
    return res.messages || []
  }, [token])

  const reloadInitial = useCallback(async () => {
    setError('')
    const list = await fetchMessages({})
    setMessages(list)
  }, [fetchMessages])

  useEffect(() => {
    if (!token) return
    if (banned) return

    let alive = true

    ;(async () => {
      try {
        await reloadInitial()
      } catch (err) {
        if (!alive) return
        if (!handleAuthError(err)) setError(err?.message || 'Failed to load messages')
      }
    })()

    if (!API_BASE && import.meta.env.PROD) {
      setRealtimeMode('polling')
      setError(MISSING_SOCKET_API_BASE_MESSAGE)
      return () => {
        alive = false
      }
    }

    setRealtimeMode(API_BASE ? 'websocket' : 'polling')

    if (!API_BASE) {
      return () => {
        alive = false
      }
    }

    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 2,
      timeout: 5000,
    })

    socketRef.current = socket

    socket.on('connect', () => {
      if (!alive) return
      setRealtimeMode('websocket')
    })

    socket.on('chat:newMessage', (m) => {
      applyIncomingMessages([m])
    })

    socket.on('chat:deleted', (payload) => {
      applyDeletedMessage(payload)
    })

    socket.on('connect_error', (err) => {
      if (!alive) return

      const authError = getSocketAuthError(err)
      if (authError && handleAuthError(authError)) {
        if (authError.code === 'BANNED') {
          navigate('/banned', { replace: true })
        }
        return
      }

      setRealtimeMode('polling')
      socket.disconnect()
      socketRef.current = null
    })

    socket.on('disconnect', async (reason) => {
      if (!alive) return

      if (reason !== 'io client disconnect') {
        setRealtimeMode('polling')
      }

      // If the user gets banned while connected, refresh `/me` to show the banned page.
      try {
        await refreshMe(token)
      } catch {
        // ignore
      }
    })

    return () => {
      alive = false
      socket.disconnect()
      socketRef.current = null
    }
  }, [token, banned, handleAuthError, navigate, refreshMe, reloadInitial])

  useEffect(() => {
    if (!token || banned || realtimeMode !== 'polling') return

    let cancelled = false
    let inFlight = false

    async function poll() {
      if (cancelled || inFlight) return
      inFlight = true

      try {
        const incoming = await fetchMessages({ sinceMs: latestCursorRef.current })
        if (!cancelled) applyIncomingMessages(incoming)
      } catch (err) {
        if (!cancelled && !handleAuthError(err)) {
          setError(err?.message || 'Failed to sync messages')
        }
      } finally {
        inFlight = false
      }
    }

    poll()
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [token, banned, realtimeMode, handleAuthError, fetchMessages])

  async function deleteMessage(message) {
    if (!message?.id) return

    setError('')

    const socket = socketRef.current
    if (socket?.connected) {
      const ack = await new Promise((resolve) => {
        socket.emit('chat:delete', { messageId: message.id }, (res) => resolve(res))
      })
      if (!ack?.ok) {
        setError(ack?.message || 'Delete failed')
        return
      }
      applyDeletedMessage(ack?.message)
      return
    }

    try {
      const res = await apiFetch(`/api/chat/messages/${message.id}`, { method: 'DELETE', token })
      applyDeletedMessage(res?.message)
    } catch (err) {
      if (!handleAuthError(err)) setError(err?.message || 'Delete failed')
    }
  }

  async function sendMessage() {
    setError('')
    const trimmed = text.trim()
    if (!trimmed) return

    const replyToId = replyTo?.id || null

    // Prefer websocket send so it feels real-time.
    const socket = socketRef.current
    if (socket?.connected) {
      const payload = { text: trimmed, replyToId }
      try {
        const ack = await new Promise((resolve) => {
          socket.emit('chat:send', payload, (res) => resolve(res))
        })

        if (!ack?.ok) {
          setError(ack?.message || 'Failed to send')
          return
        }

        setText('')
        setReplyTo(null)
      } catch (err) {
        if (!handleAuthError(err)) setError(err?.message || 'Failed to send')
      }
      return
    }

    // Fallback: REST send if websocket isn't connected.
    try {
      const body = {
        text: trimmed,
        replyToId: replyToId || undefined,
      }

      const res = await apiFetch('/api/chat/messages', {
        method: 'POST',
        token,
        body,
      })

      setText('')
      setReplyTo(null)

      const created = res.message
      applyIncomingMessages([created])
    } catch (err) {
      if (!handleAuthError(err)) setError(err?.message || 'Failed to send')
    }
  }

  return (
    <div className="chatShell">
      <div className="chatHeader">
        <div className="chatHeaderInner">
          <div className="chatHeaderMain">
            <div className="chatHeaderTitle">Sandesh Chat</div>
            <div className="chatHeaderSubtitle">
              Signed in as <b>{user?.username}</b>
            </div>
          </div>
          <div className="chatHeaderActions">
            <div className="chatHeaderUserPill">
              <span className="chatHeaderUserDot" />
              <span>
                {user?.role === 'admin'
                  ? 'Admin session'
                  : realtimeMode === 'websocket'
                    ? 'Live now'
                    : 'Synced every 3s'}
              </span>
            </div>
            <button
              className="ghostBtn"
              onClick={() => {
                logout()
                navigate('/login', { replace: true })
              }}
            >
              Logout
            </button>
            {user?.role === 'admin' ? (
              <button className="primaryBtn" onClick={() => navigate('/admin')}>
                Admin
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="messages" ref={messagesRef}>
        <div className="messagesList">
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              isMine={m.senderId === user?.id}
              canDelete={m.senderId === user?.id || user?.role === 'admin'}
              onReply={(msg) => setReplyTo(msg)}
              onDelete={(msg) => deleteMessage(msg)}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="composerWrap">
        <div className="composerInner">
          {error ? <div className="errorBox chatErrorBox">{error}</div> : null}

          {replyTo ? (
            <div className="replyBar">
              <div className="small">
                Replying to <b>{replyTo.senderUsername}</b>: {replyTo.text.slice(0, 120)}
              </div>
              <button className="ghostBtn" onClick={() => setReplyTo(null)} type="button">
                Cancel
              </button>
            </div>
          ) : null}

          <div className="composer">
            <textarea
              className="textarea"
              value={text}
              placeholder="Type a message..."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
            />
            <button className="primaryBtn sendBtn" onClick={sendMessage} type="button">
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
