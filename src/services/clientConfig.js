/**
 * Client config cache layer
 * Reads client config from Firestore with in-memory cache (60s TTL)
 * to keep webhook response times under 100ms
 */

const cache = new Map()
const TTL_MS = 60_000

async function getClientByNumber(db, phoneNumber) {
  const cacheKey = `num:${phoneNumber}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data

  // Find client who owns this number
  const snap = await db
    .collectionGroup('numbers')
    .where('number', '==', phoneNumber)
    .limit(1)
    .get()

  if (snap.empty) return null

  const numberDoc = snap.docs[0]
  const clientId = numberDoc.ref.parent.parent.id

  const [clientSnap, configSnap, usersSnap] = await Promise.all([
    db.collection('clients').doc(clientId).get(),
    db.collection('clients').doc(clientId).collection('config').doc('main').get(),
    db.collection('clients').doc(clientId).collection('users').get(),
  ])

  const data = {
    clientId,
    client: clientSnap.data(),
    config: configSnap.exists ? configSnap.data() : {},
    users: usersSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  }

  cache.set(cacheKey, { data, ts: Date.now() })
  return data
}

async function getClientById(db, clientId) {
  const cacheKey = `client:${clientId}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data

  const [clientSnap, configSnap] = await Promise.all([
    db.collection('clients').doc(clientId).get(),
    db.collection('clients').doc(clientId).collection('config').doc('main').get(),
  ])

  if (!clientSnap.exists) return null

  const data = {
    clientId,
    client: clientSnap.data(),
    config: configSnap.exists ? configSnap.data() : {},
  }

  cache.set(cacheKey, { data, ts: Date.now() })
  return data
}

// Call this whenever client updates their config on the web dashboard
function invalidateCache(clientId, phoneNumber) {
  if (phoneNumber) cache.delete(`num:${phoneNumber}`)
  if (clientId) cache.delete(`client:${clientId}`)
}

function isWithinBusinessHours(businessHours) {
  if (!businessHours || Object.keys(businessHours).length === 0) return true // no configuration = always open

  const now = new Date()
  const day = now.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase() // mon, tue...
  const hours = businessHours[day]

  if (!hours) return true // if day not found in config for some reason, default to open
  if (!hours.open) return false // specifically marked closed

  // Handle both old schema {from, to} and new schema {start, end}
  const startStr = hours.start || hours.from
  const endStr = hours.end || hours.to
  
  if (!startStr || !endStr) return true

  const [openH, openM] = startStr.split(':').map(Number)
  const [closeH, closeM] = endStr.split(':').map(Number)
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const openMinutes = openH * 60 + openM
  const closeMinutes = closeH * 60 + closeM

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes
}

module.exports = { getClientByNumber, getClientById, invalidateCache, isWithinBusinessHours }
