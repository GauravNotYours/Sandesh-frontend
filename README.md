# Sandesh (React frontend)

Dark-mode chat UI with:
- Login (`/login`)
- Chat (`/chat`)
- Admin panel (`/admin`) for admin users
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
- For Vercel or other hosted deployments, set `VITE_API_BASE` to your deployed backend URL, for example `https://your-backend.onrender.com`.
- If `VITE_API_BASE` is not set, the frontend uses `http://localhost:3001` in local development.
- In production, `VITE_API_BASE` should always be set unless your API is intentionally served from the same local origin.
- Because this is a SPA, configure Vercel rewrites so `/login`, `/chat`, `/admin`, `/banned` route to `index.html`.
