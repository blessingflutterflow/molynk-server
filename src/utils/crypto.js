const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex') // 32-byte hex key

function encrypt(text) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

function decrypt(encoded) {
  const [ivHex, tagHex, encryptedHex] = encoded.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

module.exports = { encrypt, decrypt }
