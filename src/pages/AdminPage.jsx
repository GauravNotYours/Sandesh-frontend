import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/useAuth.js'
import { apiFetch } from '../lib/api.js'

function sortUsers(list) {
  return [...(list || [])].sort(
    (a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime(),
  )
}

function upsertUser(list, nextUser) {
  return sortUsers([nextUser, ...(list || []).filter((user) => user.id !== nextUser.id)])
}

export default function AdminPage() {
  const navigate = useNavigate()
  const { token, logout, handleAuthError, user } = useAuth()

  const [users, setUsers] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [notice, setNotice] = useState('')

  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState('user')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [passwordTarget, setPasswordTarget] = useState(null)
  const [resetPasswordValue, setResetPasswordValue] = useState('')

  const stats = useMemo(
    () => ({
      total: users.length,
      active: users.filter((item) => !item.isBanned).length,
      banned: users.filter((item) => item.isBanned).length,
    }),
    [users],
  )

  const isBusy = Boolean(busyAction)

  const reloadUsers = useCallback(async () => {
    const res = await apiFetch('/api/admin/users', { token })
    startTransition(() => {
      setUsers(sortUsers(res.users || []))
    })
  }, [token])

  const runAdminAction = useCallback(
    async ({ actionKey, fallbackMessage, request }) => {
      setBusyAction(actionKey)
      setError('')

      try {
        return await request()
      } catch (err) {
        if (!handleAuthError(err)) setError(err?.message || fallbackMessage)
        return null
      } finally {
        setBusyAction('')
      }
    },
    [handleAuthError],
  )

  useEffect(() => {
    if (!token) return undefined

    let alive = true

    ;(async () => {
      try {
        await reloadUsers()
      } catch (err) {
        if (!alive) return
        if (!handleAuthError(err)) setError(err?.message || 'Failed to load users')
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [token, reloadUsers, handleAuthError])

  useEffect(() => {
    if (!notice) return undefined

    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const onBanToggle = useCallback(
    async (targetUser, banned) => {
      const res = await runAdminAction({
        actionKey: `ban:${targetUser.id}`,
        fallbackMessage: 'Ban action failed',
        request: () =>
          apiFetch('/api/admin/ban-user', {
            method: 'POST',
            token,
            body: { userId: targetUser.id, banned },
          }),
      })

      if (!res) return

      if (res.user) {
        startTransition(() => {
          setUsers((prev) => upsertUser(prev, res.user))
        })
      }

      setNotice(res.message || 'User updated successfully')
    },
    [runAdminAction, token],
  )

  const onCreateUser = useCallback(async () => {
    const username = newUsername.trim()
    if (username.length < 3) {
      setError('Username must be at least 3 characters')
      return
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    const res = await runAdminAction({
      actionKey: 'create-user',
      fallbackMessage: 'Create user failed',
      request: () =>
        apiFetch('/api/admin/create-user', {
          method: 'POST',
          token,
          body: { username, password: newPassword, role: newRole },
        }),
    })

    if (!res) return

    if (res.user) {
      startTransition(() => {
        setUsers((prev) => upsertUser(prev, res.user))
      })
    }

    setNewUsername('')
    setNewPassword('')
    setNewRole('user')
    setNotice(res.message || 'User created successfully')
  }, [newPassword, newRole, newUsername, runAdminAction, token])

  const openDeleteModal = useCallback((targetUser) => {
    setDeleteTarget(targetUser)
  }, [])

  const closeDeleteModal = useCallback(() => {
    if (isBusy) return
    setDeleteTarget(null)
  }, [isBusy])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return

    const deletedUser = deleteTarget
    const res = await runAdminAction({
      actionKey: `delete:${deletedUser.id}`,
      fallbackMessage: 'Delete failed',
      request: () =>
        apiFetch(`/api/admin/users/${deletedUser.id}`, {
          method: 'DELETE',
          token,
        }),
    })

    if (!res) return

    startTransition(() => {
      setUsers((prev) => prev.filter((item) => item.id !== deletedUser.id))
    })
    setDeleteTarget(null)
    setNotice(res.message || 'User deleted successfully')
  }, [deleteTarget, runAdminAction, token])

  const openResetPasswordModal = useCallback((targetUser) => {
    setPasswordTarget(targetUser)
    setResetPasswordValue('')
    setError('')
  }, [])

  const closeResetPasswordModal = useCallback(() => {
    if (isBusy) return
    setPasswordTarget(null)
    setResetPasswordValue('')
  }, [isBusy])

  const submitPasswordReset = useCallback(async () => {
    if (!passwordTarget) return
    if (resetPasswordValue.length < 6) {
      setError('New password must be at least 6 characters')
      return
    }

    const target = passwordTarget
    const res = await runAdminAction({
      actionKey: `reset:${target.id}`,
      fallbackMessage: 'Password reset failed',
      request: () =>
        apiFetch('/api/admin/reset-password', {
          method: 'POST',
          token,
          body: { userId: target.id, newPassword: resetPasswordValue },
        }),
    })

    if (!res) return

    setPasswordTarget(null)
    setResetPasswordValue('')
    setNotice(res.message || 'Password reset completed successfully')
  }, [passwordTarget, resetPasswordValue, runAdminAction, token])

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

      {notice ? (
        <div className="successBox adminSuccessBox" role="status">
          {notice}
        </div>
      ) : null}

      {error ? <div className="errorBox adminErrorBox">{error}</div> : null}

      <div className="adminHeroCards">
        <div className="adminHeroCard">
          <span>Total users</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="adminHeroCard">
          <span>Active users</span>
          <strong>{stats.active}</strong>
        </div>
        <div className="adminHeroCard">
          <span>Banned users</span>
          <strong>{stats.banned}</strong>
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
                {users.map((account) => (
                  <tr key={account.id}>
                    <td data-label="Username">
                      <div className="tableIdentity">
                        <span className="tableAvatar">
                          {String(account.username || '?').slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <div className="tablePrimary">{account.username}</div>
                          <div className="tableSecondary">User account</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Role">
                      <span className={`roleBadge ${account.role === 'admin' ? 'admin' : 'user'}`}>
                        {account.role}
                      </span>
                    </td>
                    <td data-label="Status">
                      <span className={`statusBadge ${account.isBanned ? 'banned' : 'active'}`}>
                        {account.isBanned ? 'Banned' : 'Active'}
                      </span>
                    </td>
                    <td data-label="Created" className="tableDate">
                      {account.createdAt ? new Date(account.createdAt).toLocaleDateString() : ''}
                    </td>
                    <td data-label="Actions">
                      <div className="tableActions">
                        <button
                          className="ghostBtn"
                          type="button"
                          onClick={() => onBanToggle(account, !account.isBanned)}
                          disabled={isBusy}
                        >
                          {account.isBanned ? 'Unban' : 'Ban'}
                        </button>
                        <button
                          className="ghostBtn"
                          type="button"
                          onClick={() => openResetPasswordModal(account)}
                          disabled={isBusy}
                        >
                          Reset password
                        </button>
                        <button
                          className="dangerBtn"
                          type="button"
                          onClick={() => openDeleteModal(account)}
                          disabled={isBusy}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {loading ? (
                  <tr>
                    <td colSpan={5} className="tableEmpty">
                      Loading users...
                    </td>
                  </tr>
                ) : null}
                {!loading && !users.length && !error ? (
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
                  disabled={isBusy}
                />
              </div>
              <div className="col adminField">
                <label>Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Set a secure password"
                  disabled={isBusy}
                />
              </div>
              <div className="col adminField">
                <label>Role</label>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={isBusy}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button className="primaryBtn" onClick={() => void onCreateUser()} disabled={isBusy}>
                {busyAction === 'create-user' ? 'Creating...' : 'Create'}
              </button>

              <div className="adminHelperText">
                Admin can create, ban, delete, and reset access from this panel.
              </div>
            </div>
          </div>
        </div>
      </div>

      {deleteTarget ? (
        <div className="adminModalBackdrop" onClick={closeDeleteModal}>
          <div className="adminModal" onClick={(e) => e.stopPropagation()}>
            <div className="adminModalTitle">Delete user</div>
            <div className="adminModalBody">
              This will permanently remove <b>{deleteTarget.username}</b> from the app.
            </div>
            <div className="adminModalActions">
              <button className="ghostBtn" type="button" onClick={closeDeleteModal} disabled={isBusy}>
                Cancel
              </button>
              <button className="dangerBtn" type="button" onClick={() => void confirmDelete()} disabled={isBusy}>
                {busyAction === `delete:${deleteTarget.id}` ? 'Deleting...' : 'Delete user'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {passwordTarget ? (
        <div className="adminModalBackdrop" onClick={closeResetPasswordModal}>
          <div className="adminModal" onClick={(e) => e.stopPropagation()}>
            <div className="adminModalTitle">Reset password</div>
            <div className="adminModalBody">
              Set a new password for <b>{passwordTarget.username}</b>.
            </div>
            <div className="col adminField">
              <label>New password</label>
              <input
                type="password"
                value={resetPasswordValue}
                onChange={(e) => setResetPasswordValue(e.target.value)}
                placeholder="Minimum 6 characters"
                disabled={isBusy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void submitPasswordReset()
                  }
                }}
              />
            </div>
            <div className="adminModalActions">
              <button
                className="ghostBtn"
                type="button"
                onClick={closeResetPasswordModal}
                disabled={isBusy}
              >
                Cancel
              </button>
              <button
                className="primaryBtn"
                type="button"
                onClick={() => void submitPasswordReset()}
                disabled={isBusy}
              >
                {busyAction === `reset:${passwordTarget.id}` ? 'Resetting...' : 'Reset password'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
