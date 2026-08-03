// ─────────────────────────────────────────────────────────────────────────
// Cấu hình cookie chứa refresh token (httpOnly) — thay cho việc lưu refresh token
// trong localStorage (JS đọc được => XSS đánh cắp được). httpOnly cookie thì
// JavaScript KHÔNG đọc được, nên dù có XSS cũng không lấy trực tiếp refresh token.
// ─────────────────────────────────────────────────────────────────────────

const REFRESH_COOKIE = 'refreshToken'
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

const isProd = process.env.NODE_ENV === 'production'

// FE (vd Vercel) và BE (vd Render) thường KHÁC domain => request là "cross-site",
// trình duyệt chỉ gửi kèm cookie nếu cookie có SameSite=None; Secure (bắt buộc HTTPS).
// Khi dev local (http) có thể set COOKIE_SAMESITE=lax và COOKIE_SECURE=false.
const sameSite = process.env.COOKIE_SAMESITE || (isProd ? 'none' : 'lax')
const secure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : (sameSite === 'none' ? true : isProd)

// Chỉ gửi cookie tới các route /api/auth (refresh & logout) — giảm bề mặt phơi nhiễm,
// không đính kèm vào mọi request API khác.
const baseCookieOptions = {
  httpOnly: true,
  secure,
  sameSite,
  path: '/api/auth',
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
}

const setRefreshCookie = (res, token) =>
  res.cookie(REFRESH_COOKIE, token, { ...baseCookieOptions, maxAge: SEVEN_DAYS_MS })

// clearCookie phải dùng CÙNG options (path/sameSite/secure/domain) mới xoá đúng cookie
const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE, baseCookieOptions)

module.exports = { REFRESH_COOKIE, setRefreshCookie, clearRefreshCookie, baseCookieOptions }
