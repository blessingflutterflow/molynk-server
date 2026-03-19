/**
 * Auth routes
 * - POST /auth/signup          — create client + provision Twilio
 * - POST /auth/paystack/init   — initialise Paystack transaction → returns authorization_url
 * - POST /auth/paystack/verify — verify payment → create Firebase user → provision Twilio
 * - GET  /auth/token           — generate Twilio Access Token for Flutter app
 */
const { AccessToken } = require('twilio').jwt
const { VoiceGrant } = AccessToken
const { provisionClient } = require('../services/provisioning')
const { decrypt } = require('../utils/crypto')
const { authenticate } = require('../middleware/auth')

async function authRoutes(fastify) {
  /**
   * POST /auth/signup
   * Called after Firebase Auth creates the user.
   * Creates the Firestore client record + provisions Twilio.
   */
  fastify.post('/signup', async (request, reply) => {
    const { uid, companyName, email, plan } = request.body

    if (!uid || !companyName || !email) {
      return reply.status(400).send({ error: 'uid, companyName, and email are required' })
    }

    try {
      await fastify.db.collection('clients').doc(uid).set({
        name: companyName,
        email,
        plan: plan || 'starter',
        status: 'provisioning',
        created_at: new Date().toISOString(),
      })

      await fastify.firebase.auth().setCustomUserClaims(uid, { clientId: uid })

      provisionClient(fastify, { clientId: uid, friendlyName: companyName })
        .catch(err => {
          fastify.log.error(err, `Provisioning failed for client ${uid}`)
          fastify.db.collection('clients').doc(uid).update({ status: 'provision_failed' })
        })

      return reply.status(201).send({ message: 'Account created. Provisioning in progress.' })
    } catch (err) {
      fastify.log.error(err, 'Signup error')
      return reply.status(500).send({ error: 'Failed to create account' })
    }
  })

  /**
   * POST /auth/paystack/init
   * Initialises a Paystack transaction and returns the authorization_url.
   * Frontend redirects the user to that URL — no popup needed.
   *
   * Body: { email, plan, companyName }
   * Returns: { authorization_url, reference }
   */
  fastify.post('/paystack/init', async (request, reply) => {
    const { email, plan, companyName } = request.body

    if (!email || !plan) {
      return reply.status(400).send({ error: 'email and plan are required' })
    }

    const planAmounts = {
      starter: 47900,  // R479 in kobo (Paystack uses smallest currency unit for ZAR = cents)
      growth:  84900,  // R849
      premium: 219900, // R2199
    }

    const amount = planAmounts[plan]
    if (!amount) return reply.status(400).send({ error: 'Invalid plan' })

    const callbackUrl = `${process.env.WEB_APP_URL}/signup/callback`

    try {
      const res = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          amount,
          currency: 'ZAR',
          callback_url: callbackUrl,
          metadata: {
            plan,
            company_name: companyName,
            custom_fields: [
              { display_name: 'Plan', variable_name: 'plan', value: plan },
              { display_name: 'Company', variable_name: 'company_name', value: companyName },
            ],
          },
        }),
      })

      const data = await res.json()
      if (!data.status) throw new Error(data.message || 'Paystack init failed')

      return reply.send({
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
      })
    } catch (err) {
      fastify.log.error(err, 'Paystack init error')
      return reply.status(500).send({ error: 'Payment initialisation failed' })
    }
  })

  /**
   * POST /auth/paystack/verify
   * Verifies a Paystack payment reference, then creates the Firebase user
   * and kicks off Twilio provisioning.
   *
   * Body: { reference, companyName, email, password }
   * Returns: { uid, customToken, plan }
   */
  fastify.post('/paystack/verify', async (request, reply) => {
    const { reference, companyName, email, password } = request.body

    if (!reference || !email || !password || !companyName) {
      return reply.status(400).send({ error: 'reference, email, password, and companyName are required' })
    }

    try {
      // 1. Verify payment with Paystack
      const res = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      })
      const data = await res.json()

      if (!data.status || data.data.status !== 'success') {
        return reply.status(402).send({ error: 'Payment not confirmed' })
      }

      const plan = data.data.metadata?.plan || 'starter'

      // 2. Create Firebase Auth user
      const userRecord = await fastify.firebase.auth().createUser({
        email,
        password,
        displayName: companyName,
      })

      const uid = userRecord.uid

      // 3. Create Firestore client doc + set custom claims
      await fastify.db.collection('clients').doc(uid).set({
        name: companyName,
        email,
        plan,
        paystack_reference: reference,
        status: 'provisioning',
        created_at: new Date().toISOString(),
      })

      await fastify.firebase.auth().setCustomUserClaims(uid, { clientId: uid })

      // 4. Provision Twilio subaccount async (user picks number separately)
      provisionClient(fastify, { clientId: uid, friendlyName: companyName })
        .catch(err => {
          fastify.log.error(err, `Provisioning failed for client ${uid}`)
          fastify.db.collection('clients').doc(uid).update({ status: 'provision_failed' })
        })

      // 5. Return a custom token so frontend can sign in immediately
      const customToken = await fastify.firebase.auth().createCustomToken(uid)

      return reply.status(201).send({ uid, customToken, plan })
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return reply.status(409).send({ error: 'An account with this email already exists. Please sign in.' })
      }
      fastify.log.error(err, 'Paystack verify error')
      return reply.status(500).send({ error: 'Account creation failed' })
    }
  })

  /**
   * POST /auth/reprovision
   * Re-triggers Twilio provisioning for accounts with status 'provision_failed'.
   * Protected — must be authenticated.
   */
  fastify.post('/reprovision', { preHandler: authenticate }, async (request, reply) => {
    const { clientId } = request

    try {
      const clientSnap = await fastify.db.collection('clients').doc(clientId).get()
      if (!clientSnap.exists) return reply.status(404).send({ error: 'Client not found' })

      const client = clientSnap.data()

      // Only reprovision if actually failed or stuck in provisioning
      if (client.status === 'active') {
        return reply.send({ message: 'Already provisioned' })
      }

      // Reset status
      await fastify.db.collection('clients').doc(clientId).update({ status: 'provisioning' })

      // Re-trigger async
      provisionClient(fastify, { clientId, friendlyName: client.name })
        .catch(err => {
          fastify.log.error(err, `Re-provisioning failed for client ${clientId}`)
          fastify.db.collection('clients').doc(clientId).update({ status: 'provision_failed' })
        })

      return reply.send({ message: 'Re-provisioning started' })
    } catch (err) {
      fastify.log.error(err, 'Reprovision error')
      return reply.status(500).send({ error: 'Reprovision failed' })
    }
  })

  /**
   * GET /auth/token
   * Returns a Twilio Access Token scoped to the authenticated client's subaccount.
   * Flutter app calls this on login and refreshes every 50 minutes.
   */
  fastify.get('/token', { preHandler: authenticate }, async (request, reply) => {
    const { clientId, uid } = request

    try {
      const clientSnap = await fastify.db.collection('clients').doc(clientId).get()
      if (!clientSnap.exists) return reply.status(404).send({ error: 'Client not found' })

      const client = clientSnap.data()
      if (client.status !== 'active') {
        return reply.status(403).send({ error: `Account is ${client.status}` })
      }

      const userSnap = await fastify.db
        .collection('clients').doc(clientId)
        .collection('users').doc(uid).get()

      const identity = userSnap.exists
        ? userSnap.data().twilio_identity
        : `${clientId}_${uid}`

      const token = new AccessToken(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_API_KEY_SID,
        process.env.TWILIO_API_KEY_SECRET,
        { ttl: 3600, identity }
      )

      const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: client.twiml_app_sid,
        incomingAllow: true,
      })
      token.addGrant(voiceGrant)

      // Auto-sync TwiML App URL during development (in case ngrok is restarted)
      const webhookBase = process.env.TWILIO_WEBHOOK_BASE_URL
      if (webhookBase) {
        try {
          const subClient = fastify.twilioFor(client.twilio_subaccount_sid, apiSecret)
          await subClient.applications(client.twiml_app_sid).update({
            voiceUrl: `${webhookBase}/voice/inbound/${clientId}`,
            statusCallback: `${webhookBase}/voice/status`,
          })
        } catch (syncErr) {
          fastify.log.warn(syncErr, 'Could not sync TwiML App URL')
        }
      }

      return reply.send({ token: token.toJwt(), identity, ttl: 3600 })
    } catch (err) {
      fastify.log.error(err, 'Token generation error')
      return reply.status(500).send({ error: 'Failed to generate token' })
    }
  })
}

module.exports = authRoutes
