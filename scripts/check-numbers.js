/**
 * Check what phone numbers are on the client's subaccount
 * Run with: node scripts/check-numbers.js
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

async function check() {
  const snap = await db.collection('clients').get()

  for (const doc of snap.docs) {
    const clientId = doc.id
    const data = doc.data()

    if (!data.twilio_subaccount_sid) continue

    console.log(`\nClient: ${clientId}`)
    console.log(`Subaccount SID: ${data.twilio_subaccount_sid}`)
    console.log(`primary_number in DB: ${data.primary_number || 'NOT SET'}`)
    console.log(`Status: ${data.status}`)

    try {
      const apiSecret = decrypt(data.twilio_api_secret_enc)
      const subClient = twilio(data.twilio_api_key, apiSecret, {
        accountSid: data.twilio_subaccount_sid,
      })

      const numbers = await subClient.incomingPhoneNumbers.list()
      if (numbers.length === 0) {
        console.log('Numbers on subaccount: NONE')
      } else {
        numbers.forEach(n => console.log(`Number on subaccount: ${n.phoneNumber} (${n.sid})`))
      }
    } catch (err) {
      console.error(`Error fetching numbers: ${err.message}`)
    }
  }

  process.exit(0)
}

check()
