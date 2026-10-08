# MOJI Fighter X room server

Friend-battle room server and AI special-move designer for MOJI Fighter X (Node.js 20+). Deployed on Render's free plan via `render.yaml`.

```
npm ci
node server.mjs          # PORT=8787 by default
npm test
```

`POST /specials` designs a special move from its name with Claude; it needs `ANTHROPIC_API_KEY` (set in the Render dashboard, never in this repository).
Without the key the room features still work and `/specials` answers 503. `SPECIAL_FAKE=1` uses a keyword stand-in for local testing only.
