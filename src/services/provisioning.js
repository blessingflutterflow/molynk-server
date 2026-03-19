/**
 * Twilio Provisioning Service
 * Called when a new Molynk client signs up.
 * Creates: subaccount → API key → TwiML App → stores in Firestore
 * NOTE: Number purchase is handled separately via POST /numbers/assign
 */
const { encrypt } = require('../utils/crypto')

const WEBHOOK_BASE = process.env.TWILIO_WEBHOOK_BASE_URL

async function provisionClient(fastify, { clientId, friendlyName }) {
  const { twilio, db } = fastify

  // 1. Create Twilio subaccount
  const subaccount = await twilio.api.accounts.create({
    friendlyName: `molynk_${clientId}`,
  })

  fastify.log.info({ clientId, subaccountSid: subaccount.sid }, 'Subaccount created')

  // 2. Create API Key for the subaccount (safer than using auth token directly)
  const subClient = fastify.twilioFor(subaccount.sid, subaccount.authToken)
  const apiKey = await subClient.newKeys.create({ friendlyName: `molynk_key_${clientId}` })

  fastify.log.info({ clientId }, 'API key created')

  // 3. Create TwiML App (points Twilio to our webhooks)
  const webhookBase = WEBHOOK_BASE || 'https://placeholder.molynk.co.za'
  const twimlApp = await subClient.applications.create({
    friendlyName: `molynk_app_${clientId}`,
    voiceUrl: `${webhookBase}/voice/inbound/${clientId}`,
    voiceMethod: 'POST',
    statusCallback: `${webhookBase}/voice/status`,
    statusCallbackMethod: 'POST',
  })

  fastify.log.info({ clientId, twimlAppSid: twimlApp.sid }, 'TwiML App created')

  // 4. Persist to Firestore (credentials encrypted at rest)
  // Status = 'provisioning' — becomes 'active' once user assigns a number
  await db.collection('clients').doc(clientId).update({
    twilio_subaccount_sid: subaccount.sid,
    twilio_auth_token_enc: encrypt(subaccount.authToken),
    twilio_api_key: apiKey.sid,
    twilio_api_secret_enc: encrypt(apiKey.secret),
    twiml_app_sid: twimlApp.sid,
    provisioned_at: new Date().toISOString(),
    // Keep status as 'provisioning' until user picks a number
  })

  fastify.log.info({ clientId }, 'Client provisioned — awaiting number selection')

  return {
    subaccountSid: subaccount.sid,
    twimlAppSid: twimlApp.sid,
  }
}

/**
 * Suspend a client — release number, suspend subaccount
 */
async function suspendClient(fastify, clientId) {
  const clientSnap = await fastify.db.collection('clients').doc(clientId).get()
  if (!clientSnap.exists) throw new Error('Client not found')

  const data = clientSnap.data()
  const { decrypt } = require('../utils/crypto')
  const subClient = fastify.twilioFor(
    data.twilio_subaccount_sid,
    decrypt(data.twilio_auth_token_enc)
  )

  await subClient.api.accounts(data.twilio_subaccount_sid).update({ status: 'suspended' })
  await fastify.db.collection('clients').doc(clientId).update({ status: 'suspended' })

  fastify.log.info({ clientId }, 'Client suspended')
}

module.exports = { provisionClient, suspendClient }
