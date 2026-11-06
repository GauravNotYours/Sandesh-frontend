const DATABASE_NAME = 'sandesh-e2ee'
const DATABASE_VERSION = 1
const STORE_NAME = 'keys'
const CURRENT_DEVICE_KEY = 'current-device'
const MESSAGE_PREFIX = 'e2ee:v1:'
const MAX_MESSAGE_LENGTH = 600

let databasePromise

function openDatabase() {
  if (!globalThis.indexedDB) {
    throw new Error('This browser does not support secure local encryption storage')
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Could not open encryption storage'))
      request.onblocked = () => reject(new Error('Encryption storage is blocked by another tab'))
    })
  }
  return databasePromise
}

async function readStoredKey(key) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error || new Error('Could not read encryption storage'))
  })
}

async function storeKey(key, value) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error || new Error('Could not save encryption key'))
    transaction.onabort = () =>
      reject(transaction.error || new Error('Could not save encryption key'))
  })
}

function toBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function requireCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('Secure encryption requires a modern browser and HTTPS')
  }
}

export function createCryptoId() {
  requireCrypto()
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function getConversationAad(conversationId, keyId, deviceId) {
  return new TextEncoder().encode(`sandesh-key:v1:${conversationId}:${keyId}:${deviceId}`)
}

function getMessageAad(conversationId) {
  return new TextEncoder().encode(`sandesh-message:v1:${conversationId}`)
}

export async function getOrCreateDeviceIdentity() {
  requireCrypto()
  const existing = await readStoredKey(CURRENT_DEVICE_KEY)
  if (existing?.deviceId && existing?.keyPair?.privateKey && existing?.publicKeyJwk) {
    return existing
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  )
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const identity = {
    deviceId: createCryptoId(),
    keyPair,
    publicKeyJwk,
  }
  await storeKey(CURRENT_DEVICE_KEY, identity)
  return identity
}

export async function getConversationKey(conversationId) {
  return readStoredKey(`conversation:${conversationId}`)
}

export async function saveConversationKey(conversationId, keyId, key) {
  await storeKey(`conversation:${conversationId}`, { keyId, key })
}

export async function createConversationKey() {
  requireCrypto()
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  )
  return key
}

export async function encryptConversationMessage(plaintext, conversationId, key) {
  requireCrypto()
  if (!plaintext || plaintext.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer`)
  }

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: getMessageAad(conversationId),
    },
    key,
    new TextEncoder().encode(plaintext),
  )
  return `${MESSAGE_PREFIX}${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`
}

export async function decryptConversationMessage(message, conversationId, key) {
  if (!String(message?.text || '').startsWith(MESSAGE_PREFIX)) return message
  if (!key) throw new Error('This device does not have the conversation key')

  const parts = message.text.slice(MESSAGE_PREFIX.length).split(':')
  if (parts.length !== 2) throw new Error('Encrypted message has an invalid format')

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(parts[0]),
        additionalData: getMessageAad(conversationId),
      },
      key,
      fromBase64Url(parts[1]),
    )
    return { ...message, text: new TextDecoder().decode(plaintext) }
  } catch {
    throw new Error('Could not decrypt a message with this conversation key')
  }
}

export async function encryptConversationKeyForDevice(
  key,
  conversationId,
  keyId,
  targetDevice,
) {
  requireCrypto()
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  )
  const targetPublicKey = await crypto.subtle.importKey(
    'jwk',
    targetDevice.publicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: targetPublicKey },
    ephemeralKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const rawConversationKey = await crypto.subtle.exportKey('raw', key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: getConversationAad(conversationId, keyId, targetDevice.deviceId),
    },
    wrappingKey,
    rawConversationKey,
  )
  return {
    ephemeralPublicKeyJwk: await crypto.subtle.exportKey('jwk', ephemeralKeyPair.publicKey),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  }
}

export async function decryptConversationKeyEnvelope(
  envelope,
  identity,
  conversationId,
  targetDeviceId,
) {
  requireCrypto()
  const ephemeralPublicKey = await crypto.subtle.importKey(
    'jwk',
    envelope.ephemeralPublicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephemeralPublicKey },
    identity.keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  let rawConversationKey
  try {
    rawConversationKey = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: getConversationAad(conversationId, envelope.keyId, targetDeviceId),
      },
      wrappingKey,
      fromBase64Url(envelope.ciphertext),
    )
  } catch {
    throw new Error('Could not open this conversation key on this device')
  }

  return crypto.subtle.importKey(
    'raw',
    rawConversationKey,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  )
}
