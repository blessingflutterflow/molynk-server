require('dotenv').config()
const Fastify = require('fastify')

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  trustProxy: true, // needed for Twilio signature validation behind a proxy
})

async function build() {
  // Plugins
  await app.register(require('@fastify/cors'), {
    origin: process.env.NODE_ENV === 'production'
      ? [process.env.WEB_APP_URL]
      : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  })

  await app.register(require('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute',
    // Webhooks from Twilio should not be rate limited
    skipOnError: true,
    keyGenerator: (req) => req.ip,
  })

  // Firebase + Twilio plugins
  await app.register(require('./plugins/firebase'))
  await app.register(require('./plugins/twilio'))

  // Content-type parser for Twilio webhooks (sends application/x-www-form-urlencoded)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      const parsed = Object.fromEntries(new URLSearchParams(body))
      done(null, parsed)
    }
  )

  // Routes
  await app.register(require('./routes/auth'), { prefix: '/auth' })
  await app.register(require('./routes/voice'), { prefix: '/voice' })
  await app.register(require('./routes/clients'), { prefix: '/clients' })
  await app.register(require('./routes/numbers'), { prefix: '/numbers' })

  // Health check
  app.get('/health', async () => ({ status: 'ok', service: 'molynk-backend', ts: Date.now() }))

  return app
}

async function start() {
  try {
    const server = await build()
    const port = parseInt(process.env.PORT || '3000')
    await server.listen({ port, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
