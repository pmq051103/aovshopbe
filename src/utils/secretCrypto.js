// ─────────────────────────────────────────────────────────────────────────
// Mã hoá đối xứng AES-256-GCM cho dữ liệu nhạy cảm at-rest (vd: gamePassword).
// Dùng để KHÔNG lưu mật khẩu tài khoản game dạng plaintext trong DB.
//
// ⚠️ CHƯA được gắn vào luồng đọc/ghi live (xem giải thích trong báo cáo). Muốn dùng:
//   1. Đặt biến môi trường CARD_ENC_KEY = 32 byte hex (64 ký tự). Sinh bằng:
//        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   2. Khi GHI: lưu encrypt(gamePassword).
//   3. Khi ĐỌC/hiển thị: dùng decryptMaybe(value) — tự trả nguyên văn nếu là plaintext cũ
//      (tương thích ngược, không cần migrate ngay), giải mã nếu là chuỗi đã mã hoá.
//   4. (Tuỳ chọn) Viết script migrate: đọc từng gameAccount, encrypt(gamePassword) rồi update.
// ─────────────────────────────────────────────────────────────────────────
const crypto = require('crypto')

const PREFIX = 'enc:v1:' // đánh dấu chuỗi đã mã hoá để phân biệt với plaintext cũ

const getKey = () => {
  const hex = process.env.CARD_ENC_KEY || ''
  if (hex.length !== 64) {
    throw new Error('CARD_ENC_KEY phải là 32 byte hex (64 ký tự)')
  }
  return Buffer.from(hex, 'hex')
}

const encrypt = (plain) => {
  if (plain == null || plain === '') return plain
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

const decrypt = (payload) => {
  const body = String(payload).slice(PREFIX.length)
  const [ivHex, tagHex, dataHex] = body.split(':')
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}

// Giải mã nếu là chuỗi đã mã hoá; nếu là plaintext cũ thì trả nguyên văn (tương thích ngược).
const decryptMaybe = (value) => {
  if (typeof value === 'string' && value.startsWith(PREFIX)) {
    try { return decrypt(value) } catch (e) { return value }
  }
  return value
}

module.exports = { encrypt, decrypt, decryptMaybe }
