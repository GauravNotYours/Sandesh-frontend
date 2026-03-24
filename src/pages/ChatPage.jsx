import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/AuthContext.jsx'
import { apiFetch } from '../lib/api.js'
import MessageBubble from '../components/MessageBubble.jsx'
import { io } from 'socket.io-client'

export default function ChatPage() {
  const navigate = useNavigate()
  const { token, user, banned, logout, handleAuthError, refreshMe } = useAuth()

  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [error, setError] = useState('')

  const messagesRef = useRef(null)
  const messagesEndRef = useRef(null)
  const socketRef = useRef(null)

  useLayoutEffect(() => {
    const endEl = messagesEndRef.current
    if (!endEl) return

    requestAnimationFrame(() => {
      endEl.scrollIntoView({ block: 'end' })
    })
  }, [messages])

  function applyDeletedMessage(payload) {
    if (!payload?.id) return
    setMessages((prev) =>
      prev.map((m) =>
        m.id === payload.id
          ? {
              ...m,
              isDeleted: true,
              deletedAt: payload.deletedAt || m.deletedAt || null,
              senderUsername: payload.senderUsername || m.senderUsername,
              text: '',
            }
          : m,
      ),
    )
    setReplyTo((prev) => (prev?.id === payload.id ? null : prev))
  }

  async function fetchMessages({ sinceMs } = {}) {
    const qs = sinceMs ? `?since=${sinceMs}` : ''
    const res = await apiFetch(`/api/chat/messages${qs}`, { token })
    return res.messages || []
  }

  async function reloadInitial() {
    setError('')
    const list = await fetchMessages({})
    setMessages(list)
  }

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

    const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001'
    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket'],
    })

    socketRef.current = socket

    socket.on('chat:newMessage', (m) => {
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev
        const merged = prev.concat([m])
        const trimmed = merged.length > 100 ? merged.slice(merged.length - 100) : merged
        return trimmed
      })
    })

    socket.on('chat:deleted', (payload) => {
      applyDeletedMessage(payload)
    })

    socket.on('connect_error', async (err) => {
      const msg = String(err?.message || err || '')
      const isBanned = msg.toLowerCase().includes('banned') || String(err?.code) === 'BANNED'
      const fake = { status: isBanned ? 403 : 401, code: isBanned ? 'BANNED' : undefined, message: msg }
      if (!handleAuthError(fake)) setError(msg || 'Socket connection failed')
      if (isBanned) {
        navigate('/banned', { replace: true })
      }
    })

    socket.on('disconnect', async () => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, banned])

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
      setMessages((prev) => {
        const merged = prev.concat([created])
        const trimmedList = merged.length > 100 ? merged.slice(merged.length - 100) : merged
        return trimmedList
      })
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
              <span>{user?.role === 'admin' ? 'Admin session' : 'Live now'}</span>
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
