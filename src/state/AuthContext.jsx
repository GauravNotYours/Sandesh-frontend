import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import { AuthContext } from './auth-context.js'

export default function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('sandesh_token') || '')
  const [user, setUser] = useState(null)
  const [banned, setBanned] = useState(false)
  const [loading, setLoading] = useState(true)

  const clearAuth = useCallback(() => {
    localStorage.removeItem('sandesh_token')
    setToken('')
    setUser(null)
  }, [])

  const handleAuthError = useCallback(
    (err) => {
      if (err?.status === 403 && (err?.code === 'BANNED' || String(err?.message).toLowerCase().includes('banned'))) {
        setBanned(true)
        clearAuth()
        return true
      }
      if (err?.status === 401) {
        setBanned(false)
        clearAuth()
        return true
      }
      return false
    },
    [clearAuth],
  )

  const refreshMe = useCallback(
    async (activeToken = token) => {
      if (!activeToken) {
        setLoading(false)
        return null
      }

      const res = await apiFetch('/api/auth/me', { token: activeToken })
      setUser(res.user)
      setBanned(!!res.user?.isBanned)
      setLoading(false)
      return res.user
    },
    [token],
  )

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (!token) {
          setLoading(false)
          return
        }
        await refreshMe(token)
      } catch (err) {
        if (!alive) return
        handleAuthError(err)
        setLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [token, refreshMe, handleAuthError])

  const login = useCallback(
    async ({ username, password }) => {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      })
      localStorage.setItem('sandesh_token', res.token)
      setToken(res.token)
      setUser(res.user)
      setBanned(!!res.user?.isBanned)
      return res.user
    },
    [],
  )

  const logout = useCallback(() => {
    setBanned(false)
    clearAuth()
  }, [clearAuth])

  const value = useMemo(
    () => ({
      token,
      user,
      banned,
      loading,
      login: async (vars) => {
        try {
          return await login(vars)
        } catch (err) {
          handleAuthError(err)
          throw err
        }
      },
      logout,
      refreshMe,
      handleAuthError,
      isAdmin: user?.role === 'admin',
    }),
    [token, user, banned, loading, login, logout, refreshMe, handleAuthError],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

