# Sandesh (React frontend)

Dark-mode chat UI with:
- Login (`/login`)
- Chat (`/chat`)
- Admin panel (`/admin`) for admin users (seeded as `Viparyas`)
- Banned page (`/banned`)

## Local run

1. Start the backend (see `Sandesh backend/README.md`).
2. Create `Sandesh frontend/.env`:
   - `VITE_API_BASE=http://localhost:3001`
3. Run:
   - `npm install`
   - `npm run dev`

## Notes

- `chat` page updates in real time using WebSockets (`socket.io`).
- For Vercel deployments, set `VITE_API_BASE` to your backend URL.
- Because this is a SPA, configure Vercel rewrites so `/login`, `/chat`, `/admin`, `/banned` route to `index.html`.

