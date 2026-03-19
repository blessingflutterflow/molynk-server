const fp = require('fastify-plugin')
const twilio = require('twilio')

module.exports = fp(async function (fastify) {
  // Master Twilio client — used for provisioning subaccounts
  const masterClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  )

  fastify.decorate('twilio', masterClient)

  // Helper: get a client scoped to a specific subaccount
  fastify.decorate('twilioFor', (accountSid, authToken) => {
    return twilio(accountSid, authToken)
  })
})
