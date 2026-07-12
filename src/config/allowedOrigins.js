// Danh sách origin được phép gọi API/socket.
// FRONTEND_URL có thể là 1 domain hoặc nhiều domain cách nhau bởi dấu phẩy
// (vd: "https://aovshopfe.vercel.app,https://aov-shop.com").
// Luôn cho phép thêm các origin localhost để dev/test local trỏ vào backend đã deploy (Render) mà không bị CORS chặn.
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

const configuredOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const allowedOrigins = Array.from(new Set([
  ...(configuredOrigins.length ? configuredOrigins : ['http://localhost:5173']),
  ...DEV_ORIGINS,
]))

const isOriginAllowed = (origin) => !origin || allowedOrigins.includes(origin)

module.exports = { allowedOrigins, isOriginAllowed }