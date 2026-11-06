import { useEffect, useRef, useState } from 'react'
import { AsciiReveal } from 'ascii-reveal'

export default function AsciiToast({ message, kind = 'error', onDismiss }) {
  const [exitingMessage, setExitingMessage] = useState('')
  const exiting = Boolean(message && exitingMessage === message)
  const onDismissRef = useRef(onDismiss)

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!message) return undefined

    const dismissTimer = window.setTimeout(() => setExitingMessage(message), 4200)
    return () => window.clearTimeout(dismissTimer)
  }, [message])

  useEffect(() => {
    if (!exiting) return undefined

    const removeTimer = window.setTimeout(() => onDismissRef.current?.(), 450)
    return () => window.clearTimeout(removeTimer)
  }, [exiting])

  if (!message) return null

  return (
    <AsciiReveal
      loading={exiting}
      preset="terminal"
      duration="fast"
      lazy={false}
      as="div"
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      className={`asciiToast ${kind === 'error' ? 'errorToast' : 'messageToast'}`}
    >
      <div className="asciiToastContent">
        <span className="asciiToastMark" aria-hidden="true">
          {kind === 'error' ? '!' : '>'}
        </span>
        <span className="asciiToastMessage">{message}</span>
        <button
          className="asciiToastDismiss"
          onClick={() => setExitingMessage(message)}
          type="button"
          aria-label="Dismiss notification"
        >
          x
        </button>
      </div>
    </AsciiReveal>
  )
}
