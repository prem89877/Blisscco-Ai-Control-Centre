import { handleRequest } from '../agent2/dist/server.js'

// Thin wrapper. All logic lives in agent2/*.ts (compiled to agent2/dist during `npm run build`).
export default async function handler(req, res) {
  const r = await handleRequest({ method: req.method, headers: req.headers, body: req.body })
  res.setHeader('Cache-Control', 'no-store')
  res.status(r.status).json(r.body)
}
