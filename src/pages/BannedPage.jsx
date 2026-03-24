import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/AuthContext.jsx'

export default function BannedPage() {
  const navigate = useNavigate()
  const { logout } = useAuth()

  return (
    <div className="authPage bannedPage">
      <div className="authBackdrop" />
      <div className="bannedShell">
        <div className="bannedBadge">Access Restricted</div>
        <h1>Account access has been blocked.</h1>
        <p>
          Your Sandesh account has been banned by an administrator. If you believe this
          happened by mistake, please contact the admin team for review.
        </p>
        <div className="bannedActions">
          <button
            className="ghostBtn"
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
          >
            Return to Login
          </button>
        </div>
      </div>
    </div>
  )
}

