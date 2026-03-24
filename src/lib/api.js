function normalizeBaseUrl(value) {
  return value ? value.replace(/\/+$/, '') : ''
}

function getApiBase() {
  const envBase = normalizeBaseUrl(import.meta.env.VITE_API_BASE)
  if (envBase) return envBase

  if (import.meta.env.DEV) return 'http://localhost:3001'

  return normalizeBaseUrl(window.location.origin)
}

export const API_BASE = getApiBase()

export async function apiFetch(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

