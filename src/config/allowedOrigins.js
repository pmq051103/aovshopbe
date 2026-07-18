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

// URL frontend "chính" dùng để BUILD LINK (email, redirect sau thanh toán, webhook
// return_url...) — KHÔNG được dùng nguyên process.env.FRONTEND_URL vì biến đó có thể
// chứa NHIỀU domain cách nhau bởi dấu phẩy (dành cho CORS), nếu lấy nguyên chuỗi sẽ
// tạo ra link hỏng kiểu "https://a.com,https://b.com/reset-password/...".
// Ưu tiên domain chính aovshop.id.vn (không phải bản www, không phải vercel.app),
// nếu không có thì lấy domain đầu tiên không phải vercel.app, cuối cùng mới fallback
// domain đầu tiên trong danh sách.
const primaryFrontendUrl =
  configuredOrigins.find(o => o.includes('aovshop.id.vn') && !o.includes('www.')) ||
  configuredOrigins.find(o => !o.includes('vercel.app')) ||
  configuredOrigins[0] ||
  'http://localhost:5173'

module.exports = { allowedOrigins, isOriginAllowed, primaryFrontendUrl }