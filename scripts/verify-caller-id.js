/**
 * Verify a caller ID on the subaccount + list existing verified numbers
 * Usage: node scripts/verify-caller-id.js
 */
require('dotenv').config()
const twilio = require('twilio')
const { decrypt } = require('../src/utils/crypto')
const admin = require('firebase-admin')

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
})

const db = admin.firestore()
const CLIENT_ID = 'AO5hIeflFjPxeKGo2lprEuHsv5S2'
const NUMBER_TO_VERIFY = '+27678173353' // your real SA number

async function run() {
  const snap = await db.collection('clients').doc(CLIENT_ID).get()
  const data = snap.data()

  const subClient = twilio(
    data.twilio_subaccount_sid,
    decrypt(data.twilio_auth_token_enc)
  )

  console.log('\n--- Subaccount SID:', data.twilio_subaccount_sid)

  // List existing verified caller IDs
  const existing = await subClient.outgoingCallerIds.list()
  if (existing.length === 0) {
    console.log('No verified caller IDs on this subaccount yet.')
  } else {
    console.log('\nExisting verified caller IDs:')
    existing.forEach(c => console.log(` - ${c.phoneNumber} (${c.friendlyName})`))
  }

  // Check if already verified
  const alreadyVerified = existing.find(c => c.phoneNumber === NUMBER_TO_VERIFY)
  if (alreadyVerified) {
    console.log(`\n✓ ${NUMBER_TO_VERIFY} is already verified — ready to use as callerId!`)
    process.exit(0)
  }

  // Start verification — Twilio will call/SMS the number with a code
  console.log(`\nStarting verification for ${NUMBER_TO_VERIFY}...`)
  const validation = await subClient.validationRequests.create({
    phoneNumber: NUMBER_TO_VERIFY,
    friendlyName: 'Molynk Dev Caller ID',
    callDelay: 0,
  })

  console.log('\n✓ Twilio is calling your phone now!')
  console.log('  Validation Code:', validation.validationCode)
  console.log('  When Twilio calls, enter this code on your keypad.')
  console.log('  After that, re-run this script to confirm it is verified.')

  process.exit(0)
}

run().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
