import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AsciiReveal } from 'ascii-reveal'
import { io } from 'socket.io-client'
import AsciiToast from '../components/AsciiToast.jsx'
import MessageBubble from '../components/MessageBubble.jsx'
import { API_BASE, apiFetch } from '../lib/api.js'
import {
  createCryptoId,
  createConversationKey,
  decryptConversationKeyEnvelope,
  decryptConversationMessage,
  encryptConversationKeyForDevice,
  encryptConversationMessage,
  getConversationKey,
  getOrCreateDeviceIdentity,
  saveConversationKey,
} from '../lib/encryption.js'
import { useAuth } from '../state/useAuth.js'

const MISSING_SOCKET_API_BASE_MESSAGE =
  'Missing VITE_API_BASE for production. Set it to your deployed backend URL before building the frontend.'
const MESSAGE_LIMIT = 100
const ACTIVE_POLL_INTERVAL_MS = 1500
const BACKGROUND_POLL_INTERVAL_MS = 5000
const SCROLL_BOTTOM_THRESHOLD_PX = 120

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isNearBottom(container) {
  return (
    !container ||
    container.scrollHeight - container.scrollTop - container.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD_PX
  )
}

function getPollingIntervalMs() {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
    ? ACTIVE_POLL_INTERVAL_MS
    : BACKGROUND_POLL_INTERVAL_MS
}

function createClientRequestId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function sortConversations(list) {
  return [...list].sort(
    (first, second) =>
      toTimestamp(second.lastMessageAt || second.createdAt) -
      toTimestamp(first.lastMessageAt || first.createdAt),
  )
}

function upsertConversation(list, conversation) {
  return sortConversations([
    conversation,
    ...list.filter((item) => item.id !== conversation.id),
  ])
}

function buildOptimisticMessage({ clientRequestId, text, user, replyTo, conversationId }) {
  return {
    id: `pending-${clientRequestId}`,
    clientRequestId,
    conversationId,
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

    merged.set(message.id, {
      ...merged.get(message.id),
      ...message,
      pending: message.pending ?? false,
    })
  }

  return Array.from(merged.values())
    .sort((first, second) => toTimestamp(first.createdAt) - toTimestamp(second.createdAt))
    .slice(-MESSAGE_LIMIT)
}

function attachReplyPreviews(messages) {
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  return messages.map((message) => {
    if (message.replyToText || !message.replyToMessageId) return message
    const repliedMessage = messagesById.get(message.replyToMessageId)
    if (!repliedMessage || repliedMessage.isDeleted || repliedMessage.decryptError) return message
    return {
      ...message,
      replyToText: String(repliedMessage.text || '').slice(0, 160),
      replyToSenderUsername: repliedMessage.senderUsername,
    }
  })
}

function getLatestChangeCursor(messages) {
  return messages.reduce(
    (latest, message) =>
      Math.max(latest, toTimestamp(message.createdAt), toTimestamp(message.deletedAt)),
    0,
  )
}

function getSocketAuthError(error) {
  const message = String(error?.message || '').trim()
  const lowered = message.toLowerCase()
  if (!message) return null
  if (lowered.includes('banned')) return { status: 403, code: 'BANNED', message }
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

async function decryptMessageList(conversationId, messages, key) {
  const results = await Promise.all(
    messages.map(async (message) => {
      try {
        return await decryptConversationMessage(message, conversationId, key)
      } catch {
        return { ...message, text: '[Unable to decrypt this message]', decryptError: true }
      }
    }),
  )
  return results
}

function isEncryptedText(text) {
  return String(text || '').startsWith('e2ee:v1:')
}

export default function ChatPage() {
  const navigate = useNavigate()
  const { token, user, banned, logout, handleAuthError, refreshMe } = useAuth()
  const currentUserId = user?.id

  const [conversations, setConversations] = useState([])
  const [activeConversationId, setActiveConversationId] = useState('')
  const [username, setUsername] = useState('')
  const [messages, setMessages] = useState([])
  const [unreadByConversation, setUnreadByConversation] = useState({})
  const [incomingNotice, setIncomingNotice] = useState('')
  const [deviceIdentity, setDeviceIdentity] = useState(null)
  const [deviceStatus, setDeviceStatus] = useState('registering')
  const [deviceList, setDeviceList] = useState([])
  const [deviceApprovalBusy, setDeviceApprovalBusy] = useState('')
  const [activeKeyStatus, setActiveKeyStatus] = useState('idle')
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [error, setError] = useState('')
  const [realtimeMode, setRealtimeMode] = useState('polling')
  const [conversationsLoading, setConversationsLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)

  const messagesRef = useRef(null)
  const messagesEndRef = useRef(null)
  const composerRef = useRef(null)
  const socketRef = useRef(null)
  const conversationKeysRef = useRef(new Map())
  const activeConversationIdRef = useRef('')
  const latestCursorRef = useRef(0)
  const shouldStickToBottomRef = useRef(true)
  const forceScrollRef = useRef(true)

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) || null

  useLayoutEffect(() => {
    const input = composerRef.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`
  }, [text])

  useLayoutEffect(() => {
    const endElement = messagesEndRef.current
    if (!endElement || !messages.length) return
    if (!forceScrollRef.current && !shouldStickToBottomRef.current) return
    const behavior = forceScrollRef.current ? 'smooth' : 'auto'
    requestAnimationFrame(() => {
      endElement.scrollIntoView({ block: 'end', behavior })
      shouldStickToBottomRef.current = true
      forceScrollRef.current = false
    })
  }, [messages])

  useEffect(() => {
    latestCursorRef.current = getLatestChangeCursor(messages)
  }, [messages])

  const loadConversations = useCallback(async () => {
    const response = await apiFetch('/api/chat/conversations', { token })
    setConversations(sortConversations(response.conversations || []))
  }, [token])

  const fetchMessages = useCallback(
    async (conversationId, sinceMs) => {
      const query = sinceMs ? `?since=${sinceMs}` : ''
      const response = await apiFetch(
        `/api/chat/conversations/${conversationId}/messages${query}`,
        { token },
      )
      return response.messages || []
    },
    [token],
  )

  const refreshDeviceList = useCallback(
    async (currentDeviceId) => {
      const response = await apiFetch('/api/crypto/devices', { token })
      const devices = response.devices || []
      setDeviceList(devices)
      const currentDevice = devices.find((device) => device.deviceId === currentDeviceId)
      if (currentDevice) setDeviceStatus(currentDevice.status)
      return devices
    },
    [token],
  )

  const ensureConversationKey = useCallback(
    async (conversationId) => {
      if (!deviceIdentity || deviceStatus !== 'approved') {
        throw new Error('Approve this device before opening encrypted conversations')
      }

      const metadataPath = `/api/chat/conversations/${conversationId}/keys?deviceId=${deviceIdentity.deviceId}`
      let metadata = await apiFetch(metadataPath, { token })
      let cached = await getConversationKey(conversationId)
      let key = cached?.keyId === metadata.keyId ? cached.key : null

      if (!metadata.keyId) {
        const newKey = await createConversationKey()
        const keyId = createCryptoId()
        const claim = await apiFetch(
          `/api/chat/conversations/${conversationId}/keys/claim`,
          {
            method: 'POST',
            token,
            body: { deviceId: deviceIdentity.deviceId, keyId },
          },
        )
        if (claim.claimed) {
          metadata = { ...metadata, keyId: claim.keyId }
          key = newKey
          await saveConversationKey(conversationId, claim.keyId, key)
        } else {
          for (let attempt = 0; attempt < 12 && !key; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 500))
            metadata = await apiFetch(metadataPath, { token })
            cached = await getConversationKey(conversationId)
            if (cached?.keyId === metadata.keyId) key = cached.key
            else if (metadata.envelope && metadata.keyId) {
              key = await decryptConversationKeyEnvelope(
                metadata.envelope,
                deviceIdentity,
                conversationId,
                deviceIdentity.deviceId,
              )
              await saveConversationKey(conversationId, metadata.keyId, key)
            }
          }
        }
      } else if (!key && metadata.envelope) {
        key = await decryptConversationKeyEnvelope(
          metadata.envelope,
          deviceIdentity,
          conversationId,
          deviceIdentity.deviceId,
        )
        await saveConversationKey(conversationId, metadata.keyId, key)
      }

      if (!key && metadata.keyId) {
        for (let attempt = 0; attempt < 12 && !key; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 500))
          metadata = await apiFetch(metadataPath, { token })
          cached = await getConversationKey(conversationId)
          if (cached?.keyId === metadata.keyId) key = cached.key
          else if (metadata.envelope) {
            key = await decryptConversationKeyEnvelope(
              metadata.envelope,
              deviceIdentity,
              conversationId,
              deviceIdentity.deviceId,
            )
            await saveConversationKey(conversationId, metadata.keyId, key)
          }
        }
      }

      if (!key || !metadata.keyId) {
        throw new Error(
          'This device has no conversation key yet. Approve it from one of your other devices.',
        )
      }

      conversationKeysRef.current.set(conversationId, {
        keyId: metadata.keyId,
        key,
      })

      const envelopeDeviceIds = new Set(metadata.envelopeDeviceIds || [])
      for (const targetDevice of metadata.devices || []) {
        if (envelopeDeviceIds.has(targetDevice.deviceId)) continue
        const envelope = await encryptConversationKeyForDevice(
          key,
          conversationId,
          metadata.keyId,
          targetDevice,
        )
        await apiFetch(
          `/api/chat/conversations/${conversationId}/keys/envelopes`,
          {
            method: 'POST',
            token,
            body: {
              sourceDeviceId: deviceIdentity.deviceId,
              targetDeviceId: targetDevice.deviceId,
              keyId: metadata.keyId,
              ...envelope,
            },
          },
        )
      }

      return key
    },
    [deviceIdentity, deviceStatus, token],
  )

  const applyIncomingMessages = useCallback(async (incoming, { forceScroll = false } = {}) => {
    const activeMessages = (incoming || []).filter(
      (message) => message?.conversationId === activeConversationIdRef.current,
    )
    if (!activeMessages.length) return

    const conversationId = activeMessages[0].conversationId
    let decryptedMessages = activeMessages
    if (activeMessages.some((message) => isEncryptedText(message.text))) {
      let key = conversationKeysRef.current.get(conversationId)?.key
      if (!key) {
        try {
          key = await ensureConversationKey(conversationId)
        } catch {
          key = null
        }
      }
      decryptedMessages = await decryptMessageList(conversationId, activeMessages, key)
    }
    if (conversationId !== activeConversationIdRef.current) return

    if (forceScroll) forceScrollRef.current = true
    startTransition(() => {
      setMessages((previous) =>
        attachReplyPreviews(mergeMessages(previous, decryptedMessages)),
      )
    })

    const conversationMessage = decryptedMessages[decryptedMessages.length - 1]
    setConversations((previous) => {
      const conversation = previous.find(
        (item) => item.id === conversationMessage.conversationId,
      )
      if (!conversation) return previous
      return upsertConversation(previous, {
        ...conversation,
        lastMessage: conversationMessage,
        lastMessageAt: conversationMessage.createdAt,
      })
    })
  }, [ensureConversationKey])

  const applyDeletedMessage = useCallback((payload) => {
    if (!payload?.id || payload.conversationId !== activeConversationIdRef.current) return

    startTransition(() => {
      setMessages((previous) =>
        mergeMessages(previous, [
          {
            id: payload.id,
            conversationId: payload.conversationId,
            isDeleted: true,
            deletedAt: payload.deletedAt || null,
            senderUsername: payload.senderUsername || null,
            text: '',
          },
        ]),
      )
    })
    setConversations((previous) =>
      previous.map((conversation) =>
        conversation.id === payload.conversationId &&
        conversation.lastMessage?.id === payload.id
          ? {
              ...conversation,
              lastMessage: {
                ...conversation.lastMessage,
                isDeleted: true,
                text: '',
                deletedAt: payload.deletedAt || null,
              },
            }
          : conversation,
      ),
    )
    setReplyTo((previous) => (previous?.id === payload.id ? null : previous))
  }, [])

  const approveDevice = useCallback(
    async (deviceId) => {
      if (!deviceIdentity || deviceStatus !== 'approved') return
      setDeviceApprovalBusy(deviceId)
      setError('')
      try {
        await apiFetch(`/api/crypto/devices/${deviceId}/approve`, {
          method: 'POST',
          token,
          body: { sourceDeviceId: deviceIdentity.deviceId },
        })
        await refreshDeviceList(deviceIdentity.deviceId)
        for (const conversation of conversations) {
          await ensureConversationKey(conversation.id)
        }
        setIncomingNotice('Device approved and conversation keys transferred')
      } catch (approvalError) {
        if (!handleAuthError(approvalError)) {
          setError(approvalError?.message || 'Could not approve this device')
        }
      } finally {
        setDeviceApprovalBusy('')
      }
    },
    [
      deviceIdentity,
      deviceStatus,
      token,
      conversations,
      refreshDeviceList,
      ensureConversationKey,
      handleAuthError,
    ],
  )

  useEffect(() => {
    if (!token || banned) return undefined

    let alive = true
    setConversationsLoading(true)
    loadConversations()
      .catch((loadError) => {
        if (alive && !handleAuthError(loadError)) {
          setError(loadError?.message || 'Failed to load conversations')
        }
      })
      .finally(() => {
        if (alive) setConversationsLoading(false)
      })

    return () => {
      alive = false
    }
  }, [token, banned, loadConversations, handleAuthError])

  useEffect(() => {
    if (!token || banned) return undefined

    let alive = true
    ;(async () => {
      try {
        const identity = await getOrCreateDeviceIdentity()
        const response = await apiFetch('/api/crypto/devices/register', {
          method: 'POST',
          token,
          body: {
            deviceId: identity.deviceId,
            publicKeyJwk: identity.publicKeyJwk,
          },
        })
        if (!alive) return
        setDeviceIdentity(identity)
        setDeviceStatus(response.approved ? 'approved' : 'pending')
        await refreshDeviceList(identity.deviceId)
      } catch (deviceError) {
        if (alive && !handleAuthError(deviceError)) {
          setDeviceStatus('error')
          setError(deviceError?.message || 'Could not set up secure messaging on this device')
        }
      }
    })()

    return () => {
      alive = false
    }
  }, [token, banned, refreshDeviceList, handleAuthError])

  useEffect(() => {
    if (!token || banned || !deviceIdentity) return undefined

    let cancelled = false
    let timer = null
    async function refresh() {
      try {
        await refreshDeviceList(deviceIdentity.deviceId)
      } catch (deviceError) {
        if (!cancelled && !handleAuthError(deviceError)) {
          setError(deviceError?.message || 'Could not refresh encryption devices')
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(refresh, 4000)
      }
    }
    timer = window.setTimeout(refresh, 4000)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [token, banned, deviceIdentity, refreshDeviceList, handleAuthError])

  useEffect(() => {
    if (!token || banned || realtimeMode !== 'polling') return undefined

    let cancelled = false
    let timer = null

    async function pollConversations() {
      try {
        await loadConversations()
      } catch (loadError) {
        if (!cancelled && !handleAuthError(loadError)) {
          setError(loadError?.message || 'Failed to sync conversations')
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(pollConversations, getPollingIntervalMs())
        }
      }
    }

    timer = window.setTimeout(pollConversations, getPollingIntervalMs())
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [token, banned, realtimeMode, loadConversations, handleAuthError])

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
    setMessages([])
    setReplyTo(null)
    setError('')
    if (!activeConversationId || !token || banned) {
      setMessagesLoading(false)
      setActiveKeyStatus('idle')
      return undefined
    }

    let alive = true
    setMessagesLoading(true)
    latestCursorRef.current = 0
    shouldStickToBottomRef.current = true
    forceScrollRef.current = true
    if (deviceStatus !== 'approved') {
      setMessagesLoading(false)
      setActiveKeyStatus(deviceStatus === 'pending' ? 'pending' : 'loading')
      return undefined
    }

    setActiveKeyStatus('loading')
    ensureConversationKey(activeConversationId)
      .then(async (key) => {
        const list = await fetchMessages(activeConversationId)
        return decryptMessageList(activeConversationId, list, key)
      })
      .then((list) => {
        if (alive) {
          setMessages((previous) => attachReplyPreviews(mergeMessages(previous, list)))
          setActiveKeyStatus('ready')
        }
      })
      .catch((loadError) => {
        if (alive && !handleAuthError(loadError)) {
          setActiveKeyStatus('error')
          setError(loadError?.message || 'Failed to load messages')
        }
      })
      .finally(() => {
        if (alive) setMessagesLoading(false)
      })

    return () => {
      alive = false
    }
  }, [
    activeConversationId,
    token,
    banned,
    deviceStatus,
    fetchMessages,
    ensureConversationKey,
    handleAuthError,
  ])

  useEffect(() => {
    if (
      !activeConversationId ||
      deviceStatus !== 'approved' ||
      activeKeyStatus !== 'error'
    ) {
      return undefined
    }

    let cancelled = false
    let timer = null
    async function retryKeySetup() {
      try {
        const key = await ensureConversationKey(activeConversationId)
        const list = await fetchMessages(activeConversationId)
        const decrypted = await decryptMessageList(activeConversationId, list, key)
        if (cancelled) return
        setMessages((previous) =>
          attachReplyPreviews(mergeMessages(previous, decrypted)),
        )
        setActiveKeyStatus('ready')
      } catch {
        if (!cancelled) timer = window.setTimeout(retryKeySetup, 5000)
      }
    }

    timer = window.setTimeout(retryKeySetup, 5000)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [
    activeConversationId,
    deviceStatus,
    activeKeyStatus,
    ensureConversationKey,
    fetchMessages,
  ])

  useEffect(() => {
    if (!token || banned) return undefined

    if (!API_BASE && import.meta.env.PROD) {
      setRealtimeMode('polling')
      setError(MISSING_SOCKET_API_BASE_MESSAGE)
      return undefined
    }
    if (!API_BASE) {
      setRealtimeMode('polling')
      return undefined
    }

    let alive = true
    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 2,
      reconnectionDelay: 500,
      reconnectionDelayMax: 1500,
      timeout: 5000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      if (alive) setRealtimeMode('websocket')
    })
    socket.on('chat:newMessage', (message) => {
      if (!message?.conversationId) return
      setConversations((previous) => {
        let conversation = previous.find((item) => item.id === message.conversationId)
        if (!conversation) {
          if (!message.senderId || message.senderId === currentUserId) return previous
          conversation = {
            id: message.conversationId,
            otherUser: { id: message.senderId, username: message.senderUsername },
            createdAt: message.createdAt,
          }
        }
        return upsertConversation(previous, {
          ...conversation,
          lastMessage: message,
          lastMessageAt: message.createdAt,
        })
      })
      if (message.conversationId === activeConversationIdRef.current) {
        applyIncomingMessages([message])
      } else if (message.senderId !== currentUserId) {
        setUnreadByConversation((previous) => ({
          ...previous,
          [message.conversationId]: (previous[message.conversationId] || 0) + 1,
        }))
        setIncomingNotice(
            `${message.senderUsername}: ${isEncryptedText(message.text) ? 'sent you an encrypted message' : message.text || 'sent you a message'}`,
        )
      }
    })
    socket.on('chat:deleted', applyDeletedMessage)
    socket.on('connect_error', (socketError) => {
      if (!alive) return
      const authError = getSocketAuthError(socketError)
      if (authError && handleAuthError(authError)) {
        if (authError.code === 'BANNED') navigate('/banned', { replace: true })
        return
      }
      setRealtimeMode('polling')
      socket.disconnect()
      socketRef.current = null
    })
    socket.on('disconnect', async (reason) => {
      if (!alive) return
      if (reason !== 'io client disconnect') setRealtimeMode('polling')
      try {
        await refreshMe(token)
      } catch {
        // Authentication is checked again by the API requests.
      }
    })

    return () => {
      alive = false
      socket.disconnect()
      socketRef.current = null
    }
  }, [token, currentUserId, banned, handleAuthError, navigate, refreshMe, applyIncomingMessages, applyDeletedMessage])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket || !activeConversationId) return undefined

    const joinConversation = () => {
      socket.emit('chat:join', { conversationId: activeConversationId }, (response) => {
        if (
          !response?.ok &&
          activeConversationIdRef.current === activeConversationId
        ) {
          setError(response?.message || 'Failed to join conversation')
        }
      })
    }

    if (socket.connected) joinConversation()
    else socket.once('connect', joinConversation)

    return () => {
      socket.off('connect', joinConversation)
      if (socket.connected) {
        socket.emit('chat:leave', { conversationId: activeConversationId })
      }
    }
  }, [activeConversationId, realtimeMode])

  useEffect(() => {
    if (!token || banned || realtimeMode !== 'polling' || !activeConversationId) {
      return undefined
    }

    let cancelled = false
    let inFlight = false
    let timer = null

    async function poll() {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const incoming = await fetchMessages(activeConversationId, latestCursorRef.current)
        if (!cancelled) applyIncomingMessages(incoming)
      } catch (pollError) {
        if (!cancelled && !handleAuthError(pollError)) {
          setError(pollError?.message || 'Failed to sync messages')
        }
      } finally {
        inFlight = false
        if (!cancelled) timer = window.setTimeout(poll, getPollingIntervalMs())
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [
    token,
    banned,
    realtimeMode,
    activeConversationId,
    fetchMessages,
    applyIncomingMessages,
    handleAuthError,
  ])

  const selectConversation = useCallback((conversationId) => {
    activeConversationIdRef.current = conversationId
    setActiveConversationId(conversationId)
    if (conversationId) {
      setUnreadByConversation((previous) => {
        if (!previous[conversationId]) return previous
        const next = { ...previous }
        delete next[conversationId]
        return next
      })
    }
  }, [])

  const startConversation = useCallback(
    async (event) => {
      event.preventDefault()
      const requestedUsername = username.trim()
      if (!requestedUsername) return
      setError('')
      try {
        const response = await apiFetch('/api/chat/conversations', {
          method: 'POST',
          token,
          body: { username: requestedUsername },
        })
        const conversation = response.conversation
        setConversations((previous) => upsertConversation(previous, conversation))
        setUsername('')
        selectConversation(conversation.id)
      } catch (requestError) {
        if (!handleAuthError(requestError)) {
          setError(requestError?.message || 'Failed to start conversation')
        }
      }
    },
    [username, token, handleAuthError, selectConversation],
  )

  const deleteMessage = useCallback(
    async (message) => {
      if (!message?.id || message.pending || !activeConversationId) return
      setError('')

      const socket = socketRef.current
      if (socket?.connected) {
        const response = await new Promise((resolve) => {
          socket.emit('chat:delete', { messageId: message.id }, resolve)
        })
        if (!response?.ok) {
          setError(response?.message || 'Delete failed')
          return
        }
        applyDeletedMessage(response.message)
        return
      }

      try {
        const response = await apiFetch(`/api/chat/messages/${message.id}`, {
          method: 'DELETE',
          token,
        })
        applyDeletedMessage(response?.message)
      } catch (requestError) {
        if (!handleAuthError(requestError)) {
          setError(requestError?.message || 'Delete failed')
        }
      }
    },
    [activeConversationId, token, handleAuthError, applyDeletedMessage],
  )

  const handleReply = useCallback((message) => setReplyTo(message), [])
  const handleDelete = useCallback((message) => void deleteMessage(message), [deleteMessage])

  const sendMessage = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || !activeConversationId) return
    setError('')

    let encryptedText
    try {
      const key =
        conversationKeysRef.current.get(activeConversationId)?.key ||
        (await ensureConversationKey(activeConversationId))
      encryptedText = await encryptConversationMessage(trimmed, activeConversationId, key)
    } catch (encryptionError) {
      if (!handleAuthError(encryptionError)) {
        setError(encryptionError?.message || 'Could not encrypt this message')
      }
      return
    }

    const originalReplyTo = replyTo
    const clientRequestId = createClientRequestId()
    const optimisticMessage = buildOptimisticMessage({
      clientRequestId,
      text: trimmed,
      user,
      replyTo: originalReplyTo,
      conversationId: activeConversationId,
    })
    forceScrollRef.current = true
    applyIncomingMessages([optimisticMessage], { forceScroll: true })
    setText('')
    setReplyTo(null)

    const restoreComposer = () => {
      setMessages((previous) =>
        previous.filter((message) => message.clientRequestId !== clientRequestId),
      )
      setText((previous) => previous || trimmed)
      setReplyTo((previous) => previous || originalReplyTo)
    }

    const socket = socketRef.current
    if (socket?.connected) {
      try {
        const response = await new Promise((resolve) => {
          socket.emit(
            'chat:send',
            {
              conversationId: activeConversationId,
              text: encryptedText,
              replyToId: originalReplyTo?.id || undefined,
              clientRequestId,
            },
            resolve,
          )
        })
        if (!response?.ok) {
          restoreComposer()
          setError(response?.message || 'Failed to send')
          return
        }
        applyIncomingMessages([response.message], { forceScroll: true })
      } catch (sendError) {
        restoreComposer()
        if (!handleAuthError(sendError)) setError(sendError?.message || 'Failed to send')
      }
      return
    }

    try {
      const response = await apiFetch(
        `/api/chat/conversations/${activeConversationId}/messages`,
        {
          method: 'POST',
          token,
          body: {
            text: encryptedText,
            replyToId: originalReplyTo?.id || undefined,
            clientRequestId,
          },
        },
      )
      applyIncomingMessages([response.message], { forceScroll: true })
    } catch (sendError) {
      restoreComposer()
      if (!handleAuthError(sendError)) setError(sendError?.message || 'Failed to send')
    }
  }, [
    text,
    replyTo,
    activeConversationId,
    user,
    token,
    handleAuthError,
    applyIncomingMessages,
    ensureConversationKey,
  ])

  const canCompose =
    Boolean(activeConversationId) &&
    deviceStatus === 'approved' &&
    activeKeyStatus === 'ready'
  const canSend = text.trim().length > 0 && canCompose

  return (
    <div className="chatShell">
      <AsciiReveal
        preset="decode"
        duration="fast"
        lazy={false}
        as="header"
        className="chatHeader"
      >
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
                    : 'Fast sync mode'}
              </span>
            </div>
            {user?.role === 'admin' ? (
              <button className="primaryBtn" onClick={() => navigate('/admin')} type="button">
                Admin
              </button>
            ) : null}
            <button
              className="ghostBtn"
              onClick={() => {
                logout()
                navigate('/login', { replace: true })
              }}
              type="button"
            >
              Logout
            </button>
          </div>
        </div>
      </AsciiReveal>

      <main className="chatContent">
        <aside className={`conversationSidebar ${activeConversationId ? 'mobileHidden' : ''}`}>
          <div className="conversationSidebarHeading">
            <div>
              <div className="chatHeaderEyebrow">Your inbox</div>
              <h1>Messages</h1>
            </div>
            <span className="conversationCount">{conversations.length}</span>
          </div>
          {deviceStatus === 'pending' ? (
            <AsciiReveal
              preset="decode"
              duration="fast"
              lazy={false}
              as="div"
              className="encryptionNotice"
            >
              This device is waiting for approval from one of your already approved devices.
              Encrypted conversations will be available after approval and key transfer.
            </AsciiReveal>
          ) : null}
          <form className="newConversationForm" onSubmit={startConversation}>
            <label htmlFor="recipient-username">Message someone by username</label>
            <div className="newConversationInput">
              <input
                id="recipient-username"
                autoComplete="off"
                maxLength={30}
                placeholder="Enter username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <button className="primaryBtn" disabled={!username.trim()} type="submit">
                Chat
              </button>
            </div>
          </form>

          {deviceStatus === 'approved' &&
          deviceList.some((device) => device.status === 'pending') ? (
            <div className="pendingDevices">
              <div className="conversationListHeading">Devices awaiting approval</div>
              {deviceList
                .filter((device) => device.status === 'pending')
                .map((device) => (
                  <div className="pendingDevice" key={device.deviceId}>
                    <span>New device</span>
                    <button
                      className="ghostBtn"
                      disabled={Boolean(deviceApprovalBusy)}
                      onClick={() => void approveDevice(device.deviceId)}
                      type="button"
                    >
                      {deviceApprovalBusy === device.deviceId
                        ? 'Transferring...'
                        : 'Approve and transfer keys'}
                    </button>
                  </div>
                ))}
            </div>
          ) : null}

          <div className="conversationListHeading">Previous chats</div>
          <AsciiReveal
            loading={conversationsLoading}
            preset="terminal"
            duration="fast"
            lazy={false}
            as="div"
            className="conversationItems"
          >
            {conversationsLoading ? (
              <div className="conversationLoading">Loading conversations...</div>
            ) : conversations.length ? (
              conversations.map((conversation) => {
                const lastMessage = conversation.lastMessage
                const preview = lastMessage
                  ? `${lastMessage.senderId === user?.id ? 'You: ' : ''}${lastMessage.isDeleted ? 'Message deleted' : isEncryptedText(lastMessage.text) ? 'Encrypted message' : lastMessage.text}`
                  : 'No messages yet'
                return (
                  <AsciiReveal
                    className={`conversationItem ${activeConversationId === conversation.id ? 'active' : ''}`}
                    key={conversation.id}
                    onClick={() => selectConversation(conversation.id)}
                    preset="decode"
                    duration="fast"
                    lazy={false}
                    as="button"
                    type="button"
                  >
                    <span className="conversationAvatar">
                      {conversation.otherUser.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="conversationCopy">
                      <span className="conversationUsername">
                        {conversation.otherUser.username}
                      </span>
                      <span className="conversationPreview">{preview}</span>
                    </span>
                    {unreadByConversation[conversation.id] ? (
                      <span className="conversationUnread">
                        {unreadByConversation[conversation.id]}
                      </span>
                    ) : null}
                  </AsciiReveal>
                )
              })
            ) : (
              <div className="conversationEmpty">
                No chats yet. Enter a username above to start one.
              </div>
            )}
          </AsciiReveal>
        </aside>

        <section
          className={`conversationPanel ${activeConversationId ? 'mobileVisible' : 'mobileHidden'}`}
          aria-label="Conversation"
        >
          {activeConversation ? (
            <>
              <div className="conversationToolbar">
                <button
                  className="ghostBtn conversationBack"
                  onClick={() => selectConversation('')}
                  type="button"
                >
                  Back
                </button>
                <div className="conversationToolbarIdentity">
                  <span className="conversationAvatar">
                    {activeConversation.otherUser.username.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <div className="conversationUsername">
                      {activeConversation.otherUser.username}
                    </div>
                    <div className="conversationToolbarHint">
                      {activeKeyStatus === 'ready'
                        ? 'Encrypted chat'
                        : activeKeyStatus === 'pending'
                          ? 'Waiting for device approval'
                          : activeKeyStatus === 'error'
                            ? 'Encryption key unavailable'
                            : 'Setting up encryption...'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="messages" ref={messagesRef} onScroll={() => {
                shouldStickToBottomRef.current = isNearBottom(messagesRef.current)
              }}>
                <AsciiReveal
                  loading={messagesLoading}
                  preset="terminal"
                  duration="fast"
                  lazy={false}
                  as="div"
                  className="messagesList"
                >
                  {messagesLoading ? (
                    <div className="conversationLoading">Loading messages...</div>
                  ) : messages.length ? (
                    messages.map((message) => (
                      <AsciiReveal
                        key={message.id}
                        preset="decode"
                        duration="fast"
                        lazy={false}
                        as="div"
                        className="messageReveal"
                      >
                        <MessageBubble
                          message={message}
                          isMine={message.senderId === user?.id}
                          canDelete={message.senderId === user?.id || user?.role === 'admin'}
                          onReply={handleReply}
                          onDelete={handleDelete}
                        />
                      </AsciiReveal>
                    ))
                  ) : (
                    <div className="conversationEmpty messageEmpty">
                      This is the start of your conversation with{' '}
                      {activeConversation.otherUser.username}.
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </AsciiReveal>
              </div>

              <div className="composerWrap">
                <div className="composerInner">
                  {replyTo ? (
                    <div className="replyBar">
                      <div className="small">
                        Replying to <b>{replyTo.senderUsername}</b>:{' '}
                        {replyTo.text.slice(0, 120)}
                      </div>
                      <button
                        className="ghostBtn"
                        onClick={() => setReplyTo(null)}
                        type="button"
                      >
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
                      maxLength={600}
                      placeholder={
                        activeKeyStatus === 'ready'
                          ? `Message ${activeConversation.otherUser.username}...`
                          : 'Waiting for encryption...'
                      }
                      onChange={(event) => setText(event.target.value)}
                      disabled={!canCompose}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          void sendMessage()
                        }
                      }}
                    />
                    <button
                      className="primaryBtn sendBtn"
                      disabled={!canSend}
                      onClick={() => void sendMessage()}
                      type="button"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="conversationWelcome">
              <div className="conversationWelcomeIcon">S</div>
              <h2>Your conversations, one-to-one.</h2>
              <p>Choose a previous chat or start a new one by username.</p>
            </div>
          )}
        </section>
      </main>
      <AsciiToast message={error} onDismiss={() => setError('')} />
      <AsciiToast
        message={incomingNotice}
        kind="message"
        onDismiss={() => setIncomingNotice('')}
      />
    </div>
  )
}
