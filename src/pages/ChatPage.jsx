import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/useAuth.js'
import { API_BASE, apiFetch } from '../lib/api.js'
import MessageBubble from '../components/MessageBubble.jsx'
import { io } from 'socket.io-client'

const MISSING_SOCKET_API_BASE_MESSAGE =
  'Missing VITE_API_BASE for production. Set it to your deployed backend URL before building the frontend.'
const MESSAGE_LIMIT = 100
const POLL_INTERVAL_MS = 3000
const SCROLL_BOTTOM_THRESHOLD_PX = 120

function toTimestamp(value) {
  const ms = new Date(value || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function isNearBottom(container) {
  if (!container) return true

  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    SCROLL_BOTTOM_THRESHOLD_PX
  )
}

function createClientRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function buildOptimisticMessage({ clientRequestId, text, user, replyTo }) {
  return {
    id: `pending-${clientRequestId}`,
    clientRequestId,
    text,
    senderId: user?.id || null,
    senderUsername: user?.username || 'You',
    isDeleted: false,
    deletedAt: null,
    replyToMessageId: replyTo?.id || null,
    replyToText: replyTo?.text ? String(replyTo.text).slice(0, 160) : null,
    replyToSenderUsername: replyTo?.senderUsername || null,
    createdAt: new Date().toISOString(),
    pending: true,
  }
}

function mergeMessages(existing, incoming) {
  const merged = new Map(existing.map((message) => [message.id, message]))

  for (const message of incoming || []) {
    if (!message?.id) continue

    if (message.clientRequestId) {
      for (const [id, candidate] of merged.entries()) {
        if (candidate?.clientRequestId === message.clientRequestId && id !== message.id) {
          merged.delete(id)
        }
      }
    }

    const previous = merged.get(message.id)
    merged.set(message.id, {
      ...previous,
      ...message,
      pending: message.pending ?? false,
    })
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
  const composerRef = useRef(null)
  const socketRef = useRef(null)
  const latestCursorRef = useRef(0)
  const shouldStickToBottomRef = useRef(true)
  const forceScrollRef = useRef(true)

  useLayoutEffect(() => {
    const input = composerRef.current
    if (!input) return

    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`
  }, [text])

  useLayoutEffect(() => {
    const endEl = messagesEndRef.current
    if (!endEl || !messages.length) return
    if (!forceScrollRef.current && !shouldStickToBottomRef.current) return

    const behavior = forceScrollRef.current ? 'smooth' : 'auto'

    requestAnimationFrame(() => {
      endEl.scrollIntoView({ block: 'end', behavior })
      shouldStickToBottomRef.current = true
      forceScrollRef.current = false
    })
  }, [messages])

  useEffect(() => {
    latestCursorRef.current = getLatestChangeCursor(messages)
  }, [messages])

  useEffect(() => {
    shouldStickToBottomRef.current = isNearBottom(messagesRef.current)
  }, [])

  const handleMessagesScroll = useCallback(() => {
    shouldStickToBottomRef.current = isNearBottom(messagesRef.current)
  }, [])

  const applyDeletedMessage = useCallback((payload) => {
    if (!payload?.id) return

    startTransition(() => {
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
    })

    setReplyTo((prev) => (prev?.id === payload.id ? null : prev))
  }, [])

  const applyIncomingMessages = useCallback((incoming, { forceScroll = false } = {}) => {
    if (!incoming?.length) return
    if (forceScroll) forceScrollRef.current = true

    startTransition(() => {
      setMessages((prev) => mergeMessages(prev, incoming))
    })

    const deletedIds = new Set(
      incoming.filter((message) => message?.isDeleted).map((message) => message.id),
    )
    if (deletedIds.size) {
      setReplyTo((prev) => (prev?.id && deletedIds.has(prev.id) ? null : prev))
    }
  }, [])

  const removePendingMessage = useCallback((clientRequestId) => {
    if (!clientRequestId) return

    startTransition(() => {
      setMessages((prev) =>
        prev.filter((message) => message.clientRequestId !== clientRequestId),
      )
    })
  }, [])

  const restoreComposerOnFailure = useCallback((originalText, originalReplyTo) => {
    setText((prev) => (prev ? prev : originalText))
    setReplyTo((prev) => prev ?? originalReplyTo)
  }, [])

  const fetchMessages = useCallback(
    async ({ sinceMs } = {}) => {
      const qs = sinceMs ? `?since=${sinceMs}` : ''
      const res = await apiFetch(`/api/chat/messages${qs}`, { token })
      return res.messages || []
    },
    [token],
  )

  const reloadInitial = useCallback(async () => {
    setError('')
    const list = await fetchMessages({})
    forceScrollRef.current = true
    startTransition(() => {
      setMessages(list)
    })
  }, [fetchMessages])

  useEffect(() => {
    if (!token || banned) return undefined

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

    socket.on('chat:newMessage', (message) => {
      applyIncomingMessages([message])
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
  }, [token, banned, handleAuthError, navigate, refreshMe, reloadInitial, applyIncomingMessages, applyDeletedMessage])

  useEffect(() => {
    if (!token || banned || realtimeMode !== 'polling') return undefined

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
  }, [token, banned, realtimeMode, handleAuthError, fetchMessages, applyIncomingMessages])

  const deleteMessage = useCallback(
    async (message) => {
      if (!message?.id || message.pending) return

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
        const res = await apiFetch(`/api/chat/messages/${message.id}`, {
          method: 'DELETE',
          token,
        })
        applyDeletedMessage(res?.message)
      } catch (err) {
        if (!handleAuthError(err)) setError(err?.message || 'Delete failed')
      }
    },
    [token, handleAuthError, applyDeletedMessage],
  )

  const handleReply = useCallback((message) => {
    setReplyTo(message)
  }, [])

  const handleDelete = useCallback(
    (message) => {
      void deleteMessage(message)
    },
    [deleteMessage],
  )

  const sendMessage = useCallback(async () => {
    setError('')
    const trimmed = text.trim()
    if (!trimmed) return

    const originalReplyTo = replyTo
    const replyToId = originalReplyTo?.id || null
    const clientRequestId = createClientRequestId()

    forceScrollRef.current = true
    applyIncomingMessages(
      [
        buildOptimisticMessage({
          clientRequestId,
          text: trimmed,
          user,
          replyTo: originalReplyTo,
        }),
      ],
      { forceScroll: true },
    )

    setText('')
    setReplyTo(null)

    const socket = socketRef.current
    if (socket?.connected) {
      try {
        const ack = await new Promise((resolve) => {
          socket.emit(
            'chat:send',
            { text: trimmed, replyToId, clientRequestId },
            (res) => resolve(res),
          )
        })

        if (!ack?.ok) {
          removePendingMessage(clientRequestId)
          restoreComposerOnFailure(trimmed, originalReplyTo)
          setError(ack?.message || 'Failed to send')
          return
        }

        applyIncomingMessages([ack.message], { forceScroll: true })
      } catch (err) {
        removePendingMessage(clientRequestId)
        restoreComposerOnFailure(trimmed, originalReplyTo)
        if (!handleAuthError(err)) setError(err?.message || 'Failed to send')
      }
      return
    }

    try {
      const res = await apiFetch('/api/chat/messages', {
        method: 'POST',
        token,
        body: {
          text: trimmed,
          replyToId: replyToId || undefined,
          clientRequestId,
        },
      })

      applyIncomingMessages([res.message], { forceScroll: true })
    } catch (err) {
      removePendingMessage(clientRequestId)
      restoreComposerOnFailure(trimmed, originalReplyTo)
      if (!handleAuthError(err)) setError(err?.message || 'Failed to send')
    }
  }, [
    text,
    replyTo,
    user,
    token,
    handleAuthError,
    applyIncomingMessages,
    removePendingMessage,
    restoreComposerOnFailure,
  ])

  const canSend = text.trim().length > 0

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

      <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        <div className="messagesList">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              isMine={message.senderId === user?.id}
              canDelete={message.senderId === user?.id || user?.role === 'admin'}
              onReply={handleReply}
              onDelete={handleDelete}
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
              ref={composerRef}
              className="textarea"
              rows={1}
              value={text}
              placeholder="Type a message..."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void sendMessage()
                }
              }}
            />
            <button
              className="primaryBtn sendBtn"
              onClick={() => void sendMessage()}
              type="button"
              disabled={!canSend}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
