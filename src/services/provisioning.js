/**
 * Twilio Provisioning Service
 * Called when a new Molynk client signs up.
 *
 * Architecture (learned from dev):
 * - Subaccount  → billing isolation only (not used for calls)
 * - TwiML App   → lives on MASTER account (master must own it for Access Tokens to work)
 * - Numbers     → live on MASTER account (handled separately via POST /numbers/assign)
 * - API Key     → master TWILIO_API_KEY_SID used for all tokens (no per-client keys needed)
 */
const { encrypt } = require('../utils/crypto')

const WEBHOOK_BASE = process.env.TWILIO_WEBHOOK_BASE_URL

async function provisionClient(fastify, { clientId, friendlyName }) {
  const { twilio: masterClient, db } = fastify

  // 1. Create Twilio subaccount (billing isolation only)
  const subaccount = await masterClient.api.accounts.create({
    friendlyName: `molynk_${clientId}`,
  })
  fastify.log.info({ clientId, subaccountSid: subaccount.sid }, 'Subaccount created')

  // 2. Create TwiML App on MASTER account (critical — must be on master for Access Tokens)
  const webhookBase = WEBHOOK_BASE || 'https://placeholder.molynk.co.za'
  const twimlApp = await masterClient.applications.create({
    friendlyName: `molynk_app_${clientId}`,
    voiceUrl: `${webhookBase}/voice/inbound/${clientId}`,
    voiceMethod: 'POST',
    statusCallback: `${webhookBase}/voice/status`,
    statusCallbackMethod: 'POST',
  })
  fastify.log.info({ clientId, twimlAppSid: twimlApp.sid }, 'TwiML App created on master account')

  // 3. Persist to Firestore
  // Note: no API key stored — all tokens use master TWILIO_API_KEY_SID from env
  await db.collection('clients').doc(clientId).update({
    twilio_subaccount_sid: subaccount.sid,
    twilio_auth_token_enc: encrypt(subaccount.authToken),
    twiml_app_sid: twimlApp.sid,
    provisioned_at: new Date().toISOString(),
  })

  fastify.log.info({ clientId }, 'Client provisioned — awaiting number selection')

  return {
    subaccountSid: subaccount.sid,
    twimlAppSid: twimlApp.sid,
  }
}

/**
 * Suspend a client — suspend their subaccount
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
