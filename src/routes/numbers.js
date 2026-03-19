/**
 * Numbers routes — available number search + assignment
 * All routes require Firebase auth
 */
const { authenticate } = require('../middleware/auth')

async function numbersRoutes(fastify) {
  fastify.addHook('preHandler', authenticate)

  /**
   * GET /numbers/available?areaCode=011
   * Lists available SA phone numbers from Twilio's master account.
   * Does NOT require the subaccount to be fully provisioned yet.
   * Called from the number-selection screen post-signup.
   */
  fastify.get('/available', async (request, reply) => {
    const { areaCode } = request.query

    try {
      // SA numbers use 'contains' with full prefix, not areaCode
      // e.g. areaCode 011 → contains '+2711'
      const prefixMap = {
        '011': '+2711', // Johannesburg
        '021': '+2721', // Cape Town
        '031': '+2731', // Durban
        '012': '+2712', // Pretoria
        '041': '+2741', // Gqeberha
        '043': '+2743', // East London
      }

      const searchParams = { limit: 8, voiceEnabled: true }
      if (areaCode && prefixMap[areaCode]) {
        searchParams.contains = prefixMap[areaCode]
      }

      let available = await fastify.twilio.availablePhoneNumbers('ZA').local.list(searchParams)

      // If no results with prefix filter, try without (show any available SA number)
      if (!available.length) {
        available = await fastify.twilio.availablePhoneNumbers('ZA').local.list({ limit: 8, voiceEnabled: true })
      }

      return reply.send({
        numbers: available.map(n => ({
          phoneNumber: n.phoneNumber,
          friendlyName: n.friendlyName,
          locality: n.locality || null,
          region: n.region || null,
        }))
      })
    } catch (err) {
      fastify.log.error(err, 'Number search error')
      return reply.status(500).send({ error: 'Could not fetch available numbers' })
    }
  })


  /**
   * POST /numbers/assign
   * Purchases the chosen phone number for the client's subaccount.
   * Only allowed once — checks if client already has a number.
   *
   * Body: { phoneNumber }
   */
  fastify.post('/assign', async (request, reply) => {
    const { phoneNumber } = request.body
    const { clientId } = request

    if (!phoneNumber) return reply.status(400).send({ error: 'phoneNumber is required' })

    try {
      const clientSnap = await fastify.db.collection('clients').doc(clientId).get()
      if (!clientSnap.exists) return reply.status(404).send({ error: 'Client not found' })

      const client = clientSnap.data()

      fastify.log.info({ clientId, fields: Object.keys(client) }, 'Assigning number — client doc fields')

      // Guard: check if they already have a number
      const existingNumbers = await fastify.db
        .collection('clients').doc(clientId)
        .collection('numbers').limit(1).get()

      if (!existingNumbers.empty) {
        return reply.status(409).send({ error: 'Number already assigned' })
      }

      const WEBHOOK_BASE = process.env.TWILIO_WEBHOOK_BASE_URL || 'https://placeholder.molynk.co.za'

      // NOTE: Number purchase uses master Twilio account.
      // Subaccounts require a Twilio Regulatory Bundle approval for SA numbers (takes days).
      // The webhook URL encodes clientId so we route calls correctly regardless of account.
      // In production, set up a Regulatory Bundle per client via Twilio Console.
      const purchaseClient = fastify.twilio
      fastify.log.info({ clientId }, 'Purchasing number via master account')

      // Purchase the number
      // SA numbers require a registered address (Twilio regulatory requirement)
      // Auto-create one in the subaccount if it doesn't exist
      let addressSid
      try {
        const existingAddresses = await purchaseClient.addresses.list({ limit: 1 })
        if (existingAddresses.length > 0) {
          addressSid = existingAddresses[0].sid
          fastify.log.info({ clientId, addressSid }, 'Using existing address')
        } else {
          // Create a placeholder SA business address to satisfy regulatory requirement
          const address = await purchaseClient.addresses.create({
            customerName: client.name || 'Molynk Business',
            street: '1 Business Street',
            city: 'Johannesburg',
            region: 'Gauteng',
            postalCode: '2000',
            isoCountry: 'ZA',
          })
          addressSid = address.sid
          fastify.log.info({ clientId, addressSid }, 'Created placeholder address')
        }
      } catch (addrErr) {
        fastify.log.warn(addrErr, 'Could not create address — attempting purchase without')
      }

      let purchased
      try {
        purchased = await purchaseClient.incomingPhoneNumbers.create({
          phoneNumber,
          voiceUrl: `${WEBHOOK_BASE}/voice/inbound/${clientId}`,
          voiceMethod: 'POST',
          statusCallbackUrl: `${WEBHOOK_BASE}/voice/status`,
          ...(addressSid ? { addressSid } : {}),
        })
      } catch (twilioErr) {
        // Twilio error 21649 = Regulatory Bundle required for this country
        // In dev: mock the purchase so onboarding flow can be fully tested.
        // In production: submit Molynk's business docs to Twilio to get an
        // approved SA Bundle SID then pass it here.
        if (twilioErr.code === 21649 && process.env.NODE_ENV !== 'production') {
          fastify.log.warn(
            { clientId, phoneNumber },
            '[DEV MOCK] Regulatory bundle required — mocking number purchase. ' +
            'In production: add TWILIO_BUNDLE_SID to .env after Twilio approves your SA bundle.'
          )
          purchased = {
            phoneNumber,
            sid: `MOCK_${Date.now()}`,
            friendlyName: phoneNumber,
          }
        } else {
          throw twilioErr
        }
      }

      // Save to Firestore
      await fastify.db
        .collection('clients').doc(clientId)
        .collection('numbers').doc(purchased.sid)
        .set({
          number: purchased.phoneNumber,
          twilio_number_sid: purchased.sid,
          friendly_name: purchased.friendlyName,
          mock: purchased.sid.startsWith('MOCK_') || false,
          created_at: new Date().toISOString(),
        })

      // Set client active
      await fastify.db.collection('clients').doc(clientId).update({
        status: 'active',
        primary_number: purchased.phoneNumber,
      })

      fastify.log.info({ clientId, number: purchased.phoneNumber }, 'Number assigned')

      return reply.status(201).send({
        phoneNumber: purchased.phoneNumber,
        sid: purchased.sid,
      })
    } catch (err) {
      fastify.log.error(err, 'Number assign error')
      return reply.status(500).send({ error: 'Could not assign number' })
    }
  })
}

module.exports = numbersRoutes
