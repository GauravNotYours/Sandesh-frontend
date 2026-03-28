import { memo, useEffect, useRef, useState } from 'react'

function MessageBubble({ message, isMine, canDelete, onReply, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const timerRef = useRef(null)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return undefined

    function onDocClick(e) {
      const el = rootRef.current
      if (!el) return
      if (!el.contains(e.target)) setMenuOpen(false)
    }

    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  function clearTimer() {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  function startLongPress(e) {
    if (message?.pending) return

    // Right now only open the menu on long press; user clicks "Reply".
    // This matches: "he sees reply option when he long press on that msg".
    if (e.pointerType === 'mouse' && e.button !== 0) return
    clearTimer()
    timerRef.current = setTimeout(() => {
      setMenuOpen(true)
    }, 550)
  }

  function cancelLongPress() {
    clearTimer()
  }

  const createdAt = message?.createdAt ? new Date(message.createdAt) : null
  const timeLabel = createdAt
    ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  const showReplyQuote = message?.replyToText && message?.replyToSenderUsername
  const isDeleted = !!message?.isDeleted
  const isPending = !!message?.pending

  return (
    <div
      className={`messageRow ${isMine ? 'mine' : ''}`}
      ref={rootRef}
      onContextMenu={(e) => {
        if (isPending) return
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <div
        className={`bubble ${isDeleted ? 'deleted' : ''} ${isPending ? 'pending' : ''}`}
        onPointerDown={startLongPress}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
      >
        <div className="meta">
          <span>{isMine ? 'You' : message.senderUsername}</span>
          <span className={`metaStatus ${isPending ? 'pending' : ''}`}>
            {isPending ? 'Sending...' : timeLabel}
          </span>
        </div>

        {showReplyQuote ? (
          <div className="replyQuote">
            Replying to <b>{message.replyToSenderUsername}</b>: {message.replyToText}
          </div>
        ) : null}

        {isDeleted ? (
          <div className="text deletedText">
            deleted msg - <b>{message.senderUsername}</b>
          </div>
        ) : (
          <div className="text">{message.text}</div>
        )}

        {menuOpen ? (
          <div className="miniMenu">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onReply?.(message)
              }}
            >
              Reply
            </button>
            {canDelete && !isDeleted && !isPending ? (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete?.(message)
                }}
              >
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default memo(MessageBubble)
