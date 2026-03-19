/**
 * Firebase Auth middleware
 * Verifies Bearer token, attaches uid + clientId to request
 */
async function authenticate(request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization token' })
  }

  const idToken = authHeader.slice(7)
  try {
    const decoded = await request.server.firebase.auth().verifyIdToken(idToken)
    request.uid = decoded.uid
    request.clientId = decoded.clientId || decoded.uid // clientId set as custom claim on signup
  } catch (err) {
    request.log.warn({ err }, 'Invalid Firebase token')
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
}

module.exports = { authenticate }
