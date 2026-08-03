const { isOriginAllowed } = require('../config/allowedOrigins')

// ─────────────────────────────────────────────────────────────────────────
// Chống CSRF cho các endpoint XÁC THỰC BẰNG COOKIE (refresh, logout).
// Các endpoint khác dùng Bearer access token (không tự động gửi kèm) nên không
// phải vector CSRF. Với auth-by-cookie: trình duyệt LUÔN gửi header Origin khi POST
// cross-origin => chỉ cần từ chối request có Origin/Referer không thuộc allowlist là
// chặn được form/script giả mạo từ website lạ. Request không có Origin (server-to-server,
// curl) không phải vector CSRF của trình duyệt nên cho qua.
// ─────────────────────────────────────────────────────────────────────────
const verifyCsrfOrigin = (req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    if (!isOriginAllowed(origin)) {
      return res.status(403).json({ success: false, message: 'Yêu cầu bị từ chối (CSRF)' })
    }
    return next()
  }
  const referer = req.headers.referer || req.headers.referrer
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin
      if (!isOriginAllowed(refOrigin)) {
        return res.status(403).json({ success: false, message: 'Yêu cầu bị từ chối (CSRF)' })
      }
    } catch (e) { /* referer méo mó -> bỏ qua, xử như không có */ }
  }
  next()
}

module.exports = { verifyCsrfOrigin }
