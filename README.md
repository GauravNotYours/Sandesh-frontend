# Sandesh — Frontend

The Sandesh frontend is a standalone React single-page application. It is deployed independently from the backend (for example, on Vercel) and communicates with the backend over HTTP and Socket.IO.

## Features

- Username/password login, authenticated routes, logout, and banned-account handling.
- One-to-one conversations started by username, with inbox history and unread indicators.
- Live message delivery with Socket.IO and HTTP polling fallback.
- Replies, message deletion, optimistic message sending, and ASCII reveal/animated notifications.
- Responsive layouts for desktop, tablet, and mobile.
- Client-side encryption for new conversation messages, with device approval and key transfer.
- Admin tools for managing users (available to authorized administrators).

## Technology

- React 19, React Router, and Vite.
- `socket.io-client` for realtime messaging.
- `ascii-reveal` for content transitions and notifications.
- Web Crypto API and IndexedDB for encryption keys.
- Vercel Analytics.

## Project layout

```text
src/
  components/   Reusable message and toast components
  lib/          API client and browser encryption helpers
  pages/        Login, chat, admin, and banned-account screens
  state/        Authentication context and hooks
  App.jsx       Browser routes and access control
  App.css       Application and responsive styles
  main.jsx      React entry point
```

## Requirements

- Node.js `^20.19.0` or `>=22.12.0` (Node 22 is selected by `.nvmrc`).
- npm.
- A running Sandesh backend. See the backend project's own README for its setup and deployment.

## Local development

From this directory:

```sh
npm ci
npm run dev
```

Vite uses `http://localhost:3001` as the development backend default. To use another backend, set `VITE_API_BASE` in a local `.env.local` file:

```env
VITE_API_BASE=http://localhost:3001
```

Set the value to the backend origin only (for example, `https://your-backend.example.com`); the frontend adds `/api` to API paths. A trailing `/api` is also accepted and normalized. Do not put credentials or secrets in a `VITE_*` variable: Vite embeds these values in the public client bundle.

Useful commands:

```sh
npm run dev       # Start the Vite development server
npm run lint      # Run ESLint
npm run build     # Create the production build in dist/
npm run preview   # Preview the production build locally
```

## Configuration and deployment

Deploy this directory as its own Vercel project:

1. Use this folder as the project root.
2. Set the build command to `npm run build` and the output directory to `dist`.
3. Configure `VITE_API_BASE` in the Vercel project's environment variables to the backend's public origin.
4. Redeploy after changing the environment variable; Vite reads it at build time.

`vercel.json` rewrites browser routes to `index.html`, so routes such as `/chat` and `/admin` work on refresh. The backend must allow the deployed frontend origin through its CORS configuration. Use HTTPS for hosted deployments; Web Crypto requires a secure context (localhost is also treated as secure by browsers).

The frontend can fall back to polling if Socket.IO is unavailable, but the backend must still be reachable for API requests. A missing `VITE_API_BASE` in a hosted production build is an error and should be corrected in Vercel configuration.

## Authentication and browser storage

- The JWT is kept in browser `localStorage` under `sandesh_token` and sent as a bearer token to protected API routes.
- The device identity and non-exportable ECDH private key, plus conversation keys, are stored in IndexedDB for the current browser profile.
- Clearing site data, changing browser profiles, or losing the device's IndexedDB keys can prevent access to encrypted conversations. An additional device must be approved and receive key envelopes from an already approved device.

## Encryption behavior and limitations

- New messages are encrypted in the browser with AES-GCM before being sent to the backend.
- Conversation keys are shared with approved devices using ECDH P-256 and encrypted key envelopes.
- The first registered device for an account is approved automatically. Later devices remain pending until an approved device approves them and transfers keys.
- Existing messages that predate encryption remain plaintext and are displayed as before. The backend retains only the encrypted payload for new messages.
- This implementation does not independently verify peer public keys. A compromised backend could substitute device keys; the current “Encrypted chat” label does not mean keys have been authenticated out of band.
- Encryption protects message contents in storage and transport from parties without the conversation key. It does not protect against a compromised browser, device, or frontend origin.

## Main frontend behavior

- `src/lib/api.js` centralizes requests and resolves `VITE_API_BASE`.
- `src/state/AuthContext.jsx` handles session restoration, login, logout, and auth failures.
- `src/pages/ChatPage.jsx` handles conversations, message history, realtime updates, encryption, device approval, and composer state.
- `src/lib/encryption.js` implements browser key persistence, message encryption/decryption, and key envelopes.
- `src/pages/AdminPage.jsx` provides the administrator interface.
- `src/components/AsciiToast.jsx` displays animated errors and incoming-message notices.
