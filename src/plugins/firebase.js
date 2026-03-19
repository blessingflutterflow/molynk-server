const fp = require('fastify-plugin')
const admin = require('firebase-admin')

module.exports = fp(async function (fastify) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    })
  }

  const db = admin.firestore()
  db.settings({ ignoreUndefinedProperties: true })

  fastify.decorate('firebase', admin)
  fastify.decorate('db', db)
})
