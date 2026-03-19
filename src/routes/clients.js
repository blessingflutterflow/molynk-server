/**
 * Client management routes (web dashboard API)
 * All protected by Firebase auth
 */
const { authenticate } = require('../middleware/auth')
const { invalidateCache } = require('../services/clientConfig')

async function clientRoutes(fastify) {
  fastify.addHook('preHandler', authenticate)

  /** GET /clients/me — get current client profile + config */
  fastify.get('/me', async (request, reply) => {
    const { clientId } = request

    const [clientSnap, configSnap, numbersSnap, extensionsSnap, usersSnap] = await Promise.all([
      fastify.db.collection('clients').doc(clientId).get(),
      fastify.db.collection('clients').doc(clientId).collection('config').doc('main').get(),
      fastify.db.collection('clients').doc(clientId).collection('numbers').get(),
      fastify.db.collection('clients').doc(clientId).collection('extensions').orderBy('extension_number').get(),
      fastify.db.collection('clients').doc(clientId).collection('users').get(),
    ])

    if (!clientSnap.exists) return reply.status(404).send({ error: 'Not found' })

    return reply.send({
      client: { id: clientId, ...clientSnap.data() },
      config: configSnap.exists ? configSnap.data() : {},
      numbers: numbersSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      extensions: extensionsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      users: usersSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    })
  })

  /** PUT /clients/config — update call config (business hours, IVR, etc.) */
  fastify.put('/config', async (request, reply) => {
    const { clientId } = request
    const allowed = [
      'business_hours', 'ivr_enabled', 'greeting_text', 'greeting_type',
      'voicemail_enabled', 'ring_timeout', 'after_hours_message',
      'inbound_strategy', 'inbound_target'
    ]

    const update = {}
    allowed.forEach(key => {
      if (request.body[key] !== undefined) update[key] = request.body[key]
    })

    await fastify.db.collection('clients').doc(clientId).collection('config').doc('main').set(update, { merge: true })
    invalidateCache(clientId)

    return reply.send({ message: 'Config updated' })
  })

  /** GET /clients/extensions — list extensions */
  fastify.get('/extensions', async (request, reply) => {
    const snap = await fastify.db
      .collection('clients').doc(request.clientId)
      .collection('extensions').orderBy('extension_number').get()
    return reply.send(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  })

  /** POST /clients/extensions — create extension */
  fastify.post('/extensions', async (request, reply) => {
    const { extension_number, label, destination_type, destination_value, caller_id } = request.body

    if (!extension_number || !destination_type || !destination_value) {
      return reply.status(400).send({ error: 'extension_number, destination_type, and destination_value are required' })
    }

    const ref = await fastify.db
      .collection('clients').doc(request.clientId)
      .collection('extensions').add({
        extension_number,
        label: label || extension_number,
        destination_type,
        destination_value,
        caller_id: caller_id || null,
        created_at: new Date().toISOString(),
      })

    invalidateCache(request.clientId)
    return reply.status(201).send({ id: ref.id })
  })

  /** PUT /clients/extensions/:id — update extension */
  fastify.put('/extensions/:id', async (request, reply) => {
    const { id } = request.params
    const { label, destination_type, destination_value, caller_id } = request.body

    await fastify.db
      .collection('clients').doc(request.clientId)
      .collection('extensions').doc(id)
      .update({ label, destination_type, destination_value, caller_id, updated_at: new Date().toISOString() })

    invalidateCache(request.clientId)
    return reply.send({ message: 'Extension updated' })
  })

  /** DELETE /clients/extensions/:id */
  fastify.delete('/extensions/:id', async (request, reply) => {
    await fastify.db
      .collection('clients').doc(request.clientId)
      .collection('extensions').doc(request.params.id)
      .delete()

    invalidateCache(request.clientId)
    return reply.send({ message: 'Extension deleted' })
  })

  /** GET /clients/calls — paginated call history */
  fastify.get('/calls', async (request, reply) => {
    const { limit = 50, startAfter } = request.query
    let query = fastify.db
      .collection('calls')
      .where('client_id', '==', request.clientId)
      .orderBy('started_at', 'desc')
      .limit(parseInt(limit))

    if (startAfter) {
      const cursorSnap = await fastify.db.collection('calls').doc(startAfter).get()
      if (cursorSnap.exists) query = query.startAfter(cursorSnap)
    }

    const snap = await query.get()
    return reply.send(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  })

  /** GET /clients/voicemails */
  fastify.get('/voicemails', async (request, reply) => {
    const snap = await fastify.db
      .collection('clients').doc(request.clientId)
      .collection('voicemails')
      .orderBy('created_at', 'desc')
      .limit(20)
      .get()
    return reply.send(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  })

  /** POST /clients/users — invite a team member */
  fastify.post('/users', async (request, reply) => {
    const { email, name, role, extension } = request.body
    if (!email || !name || !extension) return reply.status(400).send({ error: 'email, name, and extension are required' })

    const { clientId } = request

    // 1. Get client plan to enforce limits
    const clientSnap = await fastify.db.collection('clients').doc(clientId).get()
    if (!clientSnap.exists) return reply.status(404).send({ error: 'Client not found' })
    const clientData = clientSnap.data()
    const plan = clientData.plan || 'starter'

    const PLAN_LIMITS = {
      starter: 3,
      growth: 10,
      premium: 9999,
    }
    const limit = PLAN_LIMITS[plan] || 3

    // 2. Check current number of users and validate extension uniqueness
    const usersSnap = await fastify.db.collection('clients').doc(clientId).collection('users').get()
    
    if (usersSnap.size >= limit) {
      return reply.status(403).send({ error: `Plan limit reached. Your ${plan} plan allows up to ${limit} team members. Please upgrade.` })
    }

    const extensionExists = usersSnap.docs.some(doc => doc.data().extension === extension)
    if (extensionExists) {
      return reply.status(409).send({ error: `Extension ${extension} is already assigned to another team member.` })
    }

    // 3. Create Firebase user (this acts as an invitation; in a real app, send a password reset email to invite them to set a password)
    let userRecord
    try {
      userRecord = await fastify.firebase.auth().createUser({ email, displayName: name })
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return reply.status(409).send({ error: 'A user with this email already exists.' })
      }
      throw err
    }

    const identity = `${clientId}_${userRecord.uid}`

    // 4. Set custom claims for scoping
    await fastify.firebase.auth().setCustomUserClaims(userRecord.uid, {
      clientId,
      role: role || 'staff',
    })

    // 5. Save user to client's subcollection
    await fastify.db
      .collection('clients').doc(clientId)
      .collection('users').doc(userRecord.uid)
      .set({
        name,
        email,
        role: role || 'staff',
        extension,
        twilio_identity: identity,
        status: 'invited',
        created_at: new Date().toISOString(),
      })

    return reply.status(201).send({ uid: userRecord.uid, extension, identity })
  })
}

module.exports = clientRoutes
