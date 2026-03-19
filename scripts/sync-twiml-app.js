/**
 * One-time script: update TwiML App voiceUrl to current TWILIO_WEBHOOK_BASE_URL
 * Run with: node scripts/sync-twiml-app.js
 */
require('dotenv').config()
const admin = require('firebase-admin')
const twilio = require('twilio')
const { decrypt } = require('../src/utils/crypto')

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
})

const db = admin.firestore()
const webhookBase = process.env.TWILIO_WEBHOOK_BASE_URL

async function syncAll() {
  console.log(`Syncing TwiML Apps to: ${webhookBase}\n`)

  const snap = await db.collection('clients').get()

  for (const doc of snap.docs) {
    const clientId = doc.id
    const data = doc.data()

    if (!data.twilio_subaccount_sid || !data.twiml_app_sid) {
      console.log(`[${clientId}] Skipping — not provisioned yet`)
      continue
    }

    try {
      const apiSecret = decrypt(data.twilio_api_secret_enc)
      const subClient = twilio(data.twilio_api_key, apiSecret, {
        accountSid: data.twilio_subaccount_sid,
      })

      await subClient.applications(data.twiml_app_sid).update({
        voiceUrl: `${webhookBase}/voice/inbound/${clientId}`,
        voiceMethod: 'POST',
        statusCallback: `${webhookBase}/voice/status`,
        statusCallbackMethod: 'POST',
      })

      console.log(`[${clientId}] ✓ TwiML App updated → ${webhookBase}/voice/inbound/${clientId}`)
    } catch (err) {
      console.error(`[${clientId}] ✗ Failed:`, err.message)
    }
  }

  console.log('\nDone.')
  process.exit(0)
}

syncAll()
