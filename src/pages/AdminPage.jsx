import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/AuthContext.jsx'
import { apiFetch } from '../lib/api.js'

export default function AdminPage() {
  const navigate = useNavigate()
  const { token, logout, handleAuthError, user } = useAuth()

  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState('user')

  async function reloadUsers() {
    setError('')
    const res = await apiFetch('/api/admin/users', { token })
    setUsers(res.users || [])
  }

  useEffect(() => {
    if (!token) return
    ;(async () => {
      try {
        await reloadUsers()
      } catch (err) {
        if (!handleAuthError(err)) setError(err?.message || 'Failed to load users')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function onBanToggle(u, banned) {
    setLoading(true)
    setError('')
    try {
      await apiFetch('/api/admin/ban-user', {
        method: 'POST',
        token,
        body: { userId: u.id, banned },
      })
      await reloadUsers()
    } catch (err) {
      if (!handleAuthError(err)) setError(err?.message || 'Ban action failed')
    } finally {
      setLoading(false)
    }
  }

  async function onDelete(u) {
    if (!confirm(`Delete user "${u.username}"?`)) return
    setLoading(true)
    setError('')
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE', token })
      await reloadUsers()
    } catch (err) {
      if (!handleAuthError(err)) setError(err?.message || 'Delete failed')
    } finally {
      setLoading(false)
    }
  }

  async function onResetPassword(u) {
    const newPassword = prompt(`Set new password for "${u.username}" (min 6 chars):`)
    if (!newPassword) return

    setLoading(true)
    setError('')
    try {
      await apiFetch('/api/admin/reset-password', {
        method: 'POST',
        token,
        body: { userId: u.id, newPassword },
      })
      await reloadUsers()
    } catch (err) {
      if (!handleAuthError(err)) setError(err?.message || 'Password reset failed')
    } finally {
      setLoading(false)
    }
  }

  async function onCreateUser() {
    setLoading(true)
    setError('')
    try {
      await apiFetch('/api/admin/create-user', {
        method: 'POST',
        token,
        body: { username: newUsername, password: newPassword, role: newRole },
      })
      setNewUsername('')
      setNewPassword('')
      setNewRole('user')
      await reloadUsers()
    } catch (err) {
      if (!handleAuthError(err)) setError(err?.message || 'Create user failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="adminShell">
      <div className="adminHeader">
        <div className="adminTitleBlock">
          <div className="adminEyebrow">Control Center</div>
          <div className="adminTitle">Admin Panel</div>
          <div className="adminSubtitle">
            Managing accounts as <b>{user?.username}</b>
          </div>
        </div>
        <div className="adminActions">
          <button className="ghostBtn" onClick={() => navigate('/chat')}>
            Chat
          </button>
          <button
            className="ghostBtn"
            onClick={() => {
              logout()
              navigate('/login', { replace: true })
            }}
          >
            Logout
          </button>
        </div>
      </div>

      <div className="adminHeroCards">
        <div className="adminHeroCard">
          <span>Total users</span>
          <strong>{users.length}</strong>
        </div>
        <div className="adminHeroCard">
          <span>Active users</span>
          <strong>{users.filter((u) => !u.isBanned).length}</strong>
        </div>
        <div className="adminHeroCard">
          <span>Banned users</span>
          <strong>{users.filter((u) => u.isBanned).length}</strong>
        </div>
      </div>

      <div className="adminGrid">
        <div>
          <div className="adminSectionHead">
            <div>
              <div className="adminSectionTitle">Accounts</div>
              <div className="adminSectionSubtitle">Review user roles, status, and account controls.</div>
            </div>
            <div className="adminSectionMeta">{users.length} users</div>
          </div>
          <div className="tableWrap">
            <table className="table adminUsersTable">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td data-label="Username">
                      <div className="tableIdentity">
                        <span className="tableAvatar">{String(u.username || '?').slice(0, 1).toUpperCase()}</span>
                        <div>
                          <div className="tablePrimary">{u.username}</div>
                          <div className="tableSecondary">User account</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Role">
                      <span className={`roleBadge ${u.role === 'admin' ? 'admin' : 'user'}`}>{u.role}</span>
                    </td>
                    <td data-label="Status">
                      <span className={`statusBadge ${u.isBanned ? 'banned' : 'active'}`}>
                        {u.isBanned ? 'Banned' : 'Active'}
                      </span>
                    </td>
                    <td data-label="Created" className="tableDate">
                      {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}
                    </td>
                    <td data-label="Actions">
                      <div className="tableActions">
                        <button
                          className="ghostBtn"
                          type="button"
                          onClick={() => onBanToggle(u, !u.isBanned)}
                          disabled={loading}
                        >
                          {u.isBanned ? 'Unban' : 'Ban'}
                        </button>
                        <button
                          className="ghostBtn"
                          type="button"
                          onClick={() => onResetPassword(u)}
                          disabled={loading}
                        >
                          Reset password
                        </button>
                        <button
                          className="dangerBtn"
                          type="button"
                          onClick={() => onDelete(u)}
                          disabled={loading}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!users.length && !error ? (
                  <tr>
                    <td colSpan={5} className="tableEmpty">
                      No users yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="adminSectionHead adminSectionHeadCompact">
            <div>
              <div className="adminSectionTitle">Create Account</div>
              <div className="adminSectionSubtitle">Provision new user access from one place.</div>
            </div>
          </div>
          <div className="card adminCreateCard">
            <div className="col">
              <div className="col adminField">
                <label>Username</label>
                <input
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="Choose a username"
                />
              </div>
              <div className="col adminField">
                <label>Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Set a secure password"
                />
              </div>
              <div className="col adminField">
                <label>Role</label>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button className="primaryBtn" onClick={onCreateUser} disabled={loading}>
                Create
              </button>

              {error ? <div className="errorBox">{error}</div> : null}

              <div className="adminHelperText">
                Admin can ban/delete users and create accounts for others.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
