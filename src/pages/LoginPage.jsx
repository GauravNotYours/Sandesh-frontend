import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/useAuth.js'

export default function LoginPage() {
  const navigate = useNavigate()
  const { token, banned, login } = useAuth()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (banned) navigate('/banned', { replace: true })
    else if (token) navigate('/chat', { replace: true })
  }, [banned, token, navigate])

  async function onSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login({ username, password })
      navigate('/chat', { replace: true })
    } catch (err) {
      if (err?.status === 403 && err?.code === 'BANNED') {
        navigate('/banned', { replace: true })
        return
      }
      setError(err?.message || 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="authPage">
      <div className="authBackdrop" />
      <div className="authShell">
        <section className="authWelcome">
          <div className="authBadge">Sandesh Messaging</div>
          <h1>Private conversations, clean design, faster teamwork.</h1>
          <p className="authLead">
            Welcome to Sandesh, A chat app. its a fun project by @GauravNotYours.
          </p>
          <p className="authLead">
            We don't have any legal rights.
          </p>

          <div className="authFeatureList">
            <div className="authFeatureItem">
              <span className="authFeatureDot" />
              <div>
                <strong>Real-time chat</strong>
                <p>New messages arrive instantly and stay anchored to the latest conversation.</p>
              </div>
            </div>
            <div className="authFeatureItem">
              <span className="authFeatureDot" />
              <div>
                <strong>Reply and moderation</strong>
                <p>Reply to messages, manage chat flow, and keep discussions easy to follow.</p>
              </div>
            </div>
            <div className="authFeatureItem">
              <span className="authFeatureDot" />
              <div>
                <strong>Dark professional workspace</strong>
                <p>Designed for long sessions with a cleaner, modern chat-app feel.</p>
              </div>
            </div>
          </div>

          
        </section>

        <section className="authPanel card">
          <div className="authPanelTop">
            <h2>Sign in to continue</h2>
            <p>Enter your Sandesh account details to open your conversations.</p>
          </div>

          <form onSubmit={onSubmit} className="col authForm">
            <div className="col authField">
              <label>Username</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="Enter your username"
                required
                minLength={3}
                maxLength={30}
              />
            </div>
            <div className="col authField">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Enter your password"
                required
                minLength={6}
                maxLength={100}
              />
            </div>

            <button className="primaryBtn authSubmitBtn" type="submit" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Open Chat'}
            </button>
          </form>

          {error ? <div className="errorBox">{error}</div> : null}
        </section>
      </div>
    </div>
  )
}

