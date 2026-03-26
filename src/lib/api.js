function normalizeBaseUrl(value) {
  if (!value) return ''

  const normalized = String(value).trim().replace(/\/+$/, '')

  // People often set VITE_API_BASE to `https://host/api` on Vercel.
  // The app already prefixes request paths with `/api`, so strip a trailing
  // `/api` segment here to avoid double-prefix 404s.
  return normalized.replace(/\/api$/i, '')
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function getApiBase() {
  const envBase = normalizeBaseUrl(import.meta.env.VITE_API_BASE)
  if (envBase) return envBase

  if (import.meta.env.DEV) return 'http://localhost:3001'

  // In production, only fall back to same-origin when the app is being served
  // from a local machine. Hosted frontends should set VITE_API_BASE explicitly.
  if (typeof window !== 'undefined' && isLocalHost(window.location.hostname)) {
    return normalizeBaseUrl(window.location.origin)
  }

  return ''
}

export const API_BASE = getApiBase()
const MISSING_API_BASE_MESSAGE =
  'Missing VITE_API_BASE for production. Set it to your deployed backend URL before building the frontend.'

function getRequestUrl(path) {
  if (API_BASE) return `${API_BASE}${path}`

  if (import.meta.env.PROD) {
    throw new Error(MISSING_API_BASE_MESSAGE)
  }

  return path
}

export async function apiFetch(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(getRequestUrl(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })

  const text = await res.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
  }

  if (!res.ok) {
    const err = new Error(data?.message || 'Request failed')
    err.status = res.status
    err.code = data?.code
    err.data = data
    throw err
  }

  return data
}

