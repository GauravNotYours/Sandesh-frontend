import { useMemo } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AuthProvider, { useAuth } from './state/AuthContext.jsx'

import LoginPage from './pages/LoginPage.jsx'
import ChatPage from './pages/ChatPage.jsx'
import AdminPage from './pages/AdminPage.jsx'
import BannedPage from './pages/BannedPage.jsx'

function ProtectedRoute({ children, role }) {
  const { token, user, banned, loading } = useAuth()

  if (loading) {
    return (
      <div className="page">
        <div className="card">Loading...</div>
      </div>
    )
  }

  if (banned) return <Navigate to="/banned" replace />
  if (!token) return <Navigate to="/login" replace />

  if (role && user?.role !== role) return <Navigate to="/chat" replace />

  return children
}

function AppRoutes() {
  const routes = useMemo(
    () => (
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/chat"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <ProtectedRoute role="admin">
              <AdminPage />
            </ProtectedRoute>
          }
        />
        <Route path="/banned" element={<BannedPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    ),
    [],
  )

  return routes
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
