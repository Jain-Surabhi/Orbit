# Orbit

A general-purpose AI chatbot (plain HTML/CSS/JS) with a Vercel serverless endpoint that calls Groq.

## Run locally
```
export GROQ_API_KEY=your_key     # never commit this
node dev-server.js               # http://localhost:3000
node dev-server.js --mock        # fake Groq upstream for UI testing, no key needed
node test/api.test.js            # endpoint tests (stubbed, no network)
```

## Deploy on Vercel
1. Push this folder to a GitHub repo and import it in Vercel (framework preset: **Other**, no build command).
2. Settings > Environment Variables: add `GROQ_API_KEY` (required) and optionally `GROQ_MODEL` (default `llama-3.3-70b-versatile`).
3. Deploy (redeploy after changing variables).

## Limits (api/chat.js)
2000 chars per message, last 12 messages, 12000 chars total, 1024 output tokens, 25s upstream timeout.
