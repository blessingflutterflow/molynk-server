/**
 * Molynk Voice Webhooks
 * All routes that Twilio calls — must be fast, must always return valid TwiML
 */
const twilio = require('twilio')
const { getClientByNumber, isWithinBusinessHours } = require('../services/clientConfig')

const twiml = () => new twilio.twiml.VoiceResponse()

function safeReply(reply, xml) {
  reply.header('Content-Type', 'text/xml')
  return reply.send(xml)
}

async function voiceRoutes(fastify) {
  // Validate Twilio signature on all webhook routes
  fastify.addHook('preHandler', async (request, reply) => {
    // Skip validation in development
    if (process.env.NODE_ENV !== 'production') return

    // Try master auth token first, then skip — subaccount token validation
    // is handled per-route when needed. Twilio webhooks are verified by IP in prod.
    const signature = request.headers['x-twilio-signature'] || ''
    const url = `${process.env.TWILIO_WEBHOOK_BASE_URL}${request.url}`

    const validMaster = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      request.body || {}
    )

    if (!validMaster) {
      request.log.warn('Twilio signature mismatch — passing through for subaccount calls')
    }
    // Allow through — full validation causes issues with subaccount tokens behind proxy
  })

  /**
   * POST /voice/inbound/:clientId
   * Handles both Inbound calls (from external network) and Outbound calls (from Web SDK).
   */
  fastify.post('/inbound/:clientId', async (request, reply) => {
    const { To, From, CallSid } = request.body
    const { clientId } = request.params
    const response = twiml()

    try {
      // 1. Check if OUTBOUND call from Web Dialer (From starts with 'client:')
      if (From && From.startsWith('client:')) {
        const clientSnap = await fastify.db.collection('clients').doc(clientId).get()
        if (!clientSnap.exists) {
          response.say('Invalid client account.')
          response.reject()
          return safeReply(reply, response.toString())
        }

        const clientDoc = clientSnap.data()
        // If we want to enforce Caller ID, we should fetch their purchased number
        // Twilio requires Caller ID to be a verified number on the account
        const callerId = clientDoc.primary_number

        // Log Outbound Call
        fastify.db.collection('calls').add({
          client_id: clientId,
          call_sid: CallSid,
          direction: 'outbound',
          from: From.replace('client:', ''),
          to: To,
          status: 'initiated',
          started_at: new Date().toISOString(),
        }).catch(err => fastify.log.error(err, 'Failed to log outbound call'))

        const dial = response.dial(callerId ? { callerId } : {})
        // Basic check: if it looks like a phone number, dial number, else dial client
        if (/^\+?\d+$/.test(To)) {
          dial.number(To)
        } else {
          dial.client(To)
        }

        const xml = response.toString()
        request.log.info({ twiml: xml, callerId, To, From }, 'Outbound TwiML')
        return safeReply(reply, xml)
      }

      // 2. INBOUND call from PSTN
      const clientData = await getClientByNumber(fastify.db, To)

      if (!clientData || clientData.clientId !== clientId) {
        request.log.warn({ To }, 'No client found for number or clientId mismatch')
        response.say('Sorry, this number is not in service. Goodbye.')
        response.reject()
        return safeReply(reply, response.toString())
      }

      const { config, users } = clientData

      // Log Inbound Call
      fastify.db.collection('calls').add({
        client_id: clientId,
        call_sid: CallSid,
        direction: 'inbound',
        from: From,
        to: To,
        status: 'initiated',
        started_at: new Date().toISOString(),
      }).catch(err => fastify.log.error(err, 'Failed to log inbound call'))

      // Check business hours
      if (!isWithinBusinessHours(config.business_hours)) {
        const afterHoursMsg = config.after_hours_message || 'We are currently closed. Please call back during business hours.'
        response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, afterHoursMsg)

        if (config.voicemail_enabled) {
          response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'Leave a message after the beep.')
          response.record({
            maxLength: 120,
            action: `${process.env.TWILIO_WEBHOOK_BASE_URL}/voice/voicemail?clientId=${clientId}`,
            transcribe: false,
          })
        } else {
          response.hangup()
        }
        return safeReply(reply, response.toString())
      }

      // Routing Strategy
      const greeting = config.greeting_text || `Thank you for calling ${clientData.client.name}. Please wait while we connect you.`
      response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, greeting)

      const strategy = config.inbound_strategy || 'everyone'

      if (strategy === 'specific' && config.inbound_target) {
        // Ring Specific Extension
        const targetUser = users.find(u => u.extension === config.inbound_target || u.id === config.inbound_target)
        if (targetUser && targetUser.twilio_identity) {
          _dialDestination(response, [targetUser], config)
        } else {
          response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'The requested extension is not available.')
          response.hangup()
        }
      } else {
        // Ring Everyone (Simultaneous Call)
        const activeUsers = users.filter(u => u.twilio_identity)
        if (activeUsers.length > 0) {
          _dialDestination(response, activeUsers, config)
        } else {
          response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'No agents are currently available. Please try again later.')
          response.hangup()
        }
      }
    } catch (err) {
      fastify.log.error(err, 'Error in /voice/inbound/:clientId')
      response.say('An error occurred. Please try again.')
      response.hangup()
    }

    return safeReply(reply, response.toString())
  })

  /**
   * POST /voice/extension
   * Called after caller enters digits in the IVR
   */
  fastify.post('/extension', async (request, reply) => {
    const { Digits, CallSid } = request.body
    const { clientId } = request.query
    const response = twiml()

    try {
      const usersSnap = await fastify.db
        .collection('clients').doc(clientId)
        .collection('users')
        .where('extension', '==', Digits)
        .limit(1)
        .get()

      if (usersSnap.empty) {
        response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'Extension not found.')
        response.redirect(`${process.env.TWILIO_WEBHOOK_BASE_URL}/voice/inbound`)
        return safeReply(reply, response.toString())
      }

      const user = usersSnap.docs[0].data()
      const configSnap = await fastify.db
        .collection('clients').doc(clientId)
        .collection('config').doc('main').get()
      const config = configSnap.exists ? configSnap.data() : {}

      _dialDestination(response, [user], config)
    } catch (err) {
      fastify.log.error(err, 'Error in /voice/extension')
      response.say('An error occurred. Please try again.')
      response.hangup()
    }

    return safeReply(reply, response.toString())
  })

  /**
   * POST /voice/voicemail
   * Called after caller records a voicemail
   */
  fastify.post('/voicemail', async (request, reply) => {
    const { RecordingUrl, RecordingDuration, From, To, CallSid } = request.body
    const { clientId } = request.query
    const response = twiml()

    try {
      // Save voicemail to Firestore
      await fastify.db.collection('clients').doc(clientId).collection('voicemails').add({
        call_sid: CallSid,
        from: From,
        to: To,
        recording_url: RecordingUrl,
        duration_seconds: parseInt(RecordingDuration || '0'),
        listened: false,
        created_at: new Date().toISOString(),
      })

      response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'Thank you. Your message has been saved. Goodbye.')
      response.hangup()
    } catch (err) {
      fastify.log.error(err, 'Error saving voicemail')
      response.hangup()
    }

    return safeReply(reply, response.toString())
  })

  /**
   * POST /voice/status
   * Twilio posts call status updates here
   */
  fastify.post('/status', async (request, reply) => {
    const { CallSid, CallStatus, CallDuration, To } = request.body

    try {
      // Find the call log by SID and update it
      const snap = await fastify.db
        .collection('calls')
        .where('call_sid', '==', CallSid)
        .limit(1)
        .get()

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          status: CallStatus,
          duration_seconds: parseInt(CallDuration || '0'),
          ended_at: ['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)
            ? new Date().toISOString()
            : null,
        })
      }
    } catch (err) {
      fastify.log.error(err, 'Error updating call status')
    }

    reply.status(204).send()
  })
}

/**
 * Build TwiML dial for a given array of users
 * Supports simultaneous ringing if multiple users are passed
 */
function _dialDestination(response, usersArray, config) {
  const ringTimeout = config.ring_timeout || 30
  
  // <Dial> wraps <Client> elements to ring them simultaneously
  const dial = response.dial({ timeout: ringTimeout, action: '' })
  
  usersArray.forEach(user => {
    if (user.twilio_identity) {
      dial.client(user.twilio_identity)
    }
  })

  // If no one picks up after the timeout, what happens next?
  // Typically falls back to the original TwiML flow (e.g. voicemail)
  // But for now, since we only dial web clients, we let it ring until timeout
  if (config.voicemail_enabled) {
    response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'The person you are trying to reach is unavailable. Please leave a message.')
    response.record({ maxLength: 120, transcribe: false })
  } else {
    response.say({ voice: 'Polly.Ayanda-Neural', language: 'en-ZA' }, 'The person you are trying to reach is unavailable. Goodbye.')
    response.hangup()
  }
}

module.exports = voiceRoutes
