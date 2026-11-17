import { handleRequest } from '../orchestrator/dist/orchestrator/server.js'

// Thin wrapper. All logic lives in orchestrator/*.ts (compiled during `npm run build`).
export default async function handler(req, res) {
  const r = await handleRequest({ method: req.method, headers: req.headers, body: req.body })
  res.setHeader('Cache-Control', 'no-store')
  res.status(r.status).json(r.body)
}
