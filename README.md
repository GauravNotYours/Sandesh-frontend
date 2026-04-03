# Sandesh Frontend Summary

This README explains how the frontend is built at a high level.
Sensitive values such as live backend URLs, tokens, and private deployment details are intentionally not included.

## What this frontend is

The frontend is a React single-page app built with Vite. It provides the user-facing parts of the chat product:

- login screen
- chat screen
- admin screen
- banned-access screen

## Main stack

- React 19
- Vite
- React Router
- `socket.io-client`
- Vercel Analytics
- plain CSS files for styling

## How the frontend is organized

- `src/main.jsx` starts the React app and analytics.
- `src/App.jsx` defines the route tree and wraps the app with auth state.
- `src/state/AuthContext.jsx` manages token storage, current-user loading, logout, and banned-user handling.
- `src/lib/api.js` centralizes API requests and resolves the backend base URL.
- `src/pages/LoginPage.jsx` handles sign-in.
- `src/pages/ChatPage.jsx` handles message loading, sending, replying, deleting, and live updates.
- `src/pages/AdminPage.jsx` handles admin-only account actions.
- `src/pages/BannedPage.jsx` shows the blocked account state.
- `src/components/MessageBubble.jsx` renders each message bubble and its quick actions.

## How it works

1. The app runs as a SPA and uses browser routing for `/login`, `/chat`, `/admin`, and `/banned`.
2. After login, the auth token is stored in browser storage and reused for authenticated API requests.
3. Private pages are protected in the router, and the admin page is additionally gated by user role.
4. The chat page first loads messages over HTTP, then tries to keep the UI live with Socket.IO.
5. If live sockets are not available, the frontend falls back to polling the backend.
6. Message sending uses optimistic UI so the user sees feedback before the server response fully returns.
7. The admin page uses backend APIs for account creation, banning, deletion, and password reset.

## UI and styling approach

- Most of the product styling lives in `src/App.css`.
- The design is a custom dark interface rather than a UI component framework.
- The chat view uses a fixed header, scrollable message area, and fixed composer.
- The admin area is responsive and collapses into mobile-friendly stacked layouts on smaller screens.

## How it connects to the backend

- The frontend sends requests to `/api/*` endpoints through a configured backend base URL.
- Authenticated requests include a bearer token.
- Real-time updates use Socket.IO when available and gracefully fall back to polling when not.

## Sensitive information

This README intentionally does not include:

- live API URLs
- tokens
- passwords
- private deployment origins
