const rateLimit = require('express-rate-limit');

// ─── Helper: tạo limiter theo IP thực (hoạt động đúng sau nginx/proxy) ────────
const createLimiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    // Admin được hạn mức cao gấp 20 lần (thao tác dashboard nhiều) nhưng VẪN có trần
    // — khác với 'skip' cũ vốn cho admin throughput vô hạn nếu token admin bị lộ.
    max: (req) => (req.user?.role === 'ADMIN' ? max * 20 : max),
    message: { success: false, message },
    standardHeaders: true,   // trả header RateLimit-* (RFC 6585)
    legacyHeaders: false,

    // ⚡ Quan trọng khi deploy sau nginx/cloudflare:
    // KHÔNG tự đọc raw header 'x-forwarded-for' — client có thể tự gửi header này
    // với giá trị bịa mỗi request => mỗi lần là 1 "bucket" mới => né SẠCH rate limit
    // login/OTP/deposit (lỗ hổng C4). Express đã tự suy ra IP thật từ X-Forwarded-For
    // SAU KHI bật app.set('trust proxy', 1) trong server.js và expose qua req.ip
    // (đã loại các proxy hop tin cậy). Dùng req.ip là an toàn và không giả mạo được.
    keyGenerator: (req) => req.ip,

    // KHÔNG miễn hoàn toàn rate limit cho ADMIN (nếu token admin bị lộ từ localStorage
    // thì kẻ tấn công có throughput vô hạn). Cho admin hạn mức cao gấp 20 lần thay vì bỏ qua.
    // (bỏ 'skip'; giới hạn động cho admin xử lý ở tham số max bên dưới)
  });

// ─── Các giới hạn ─────────────────────────────────────────────────────────────
//
//  global   : 500 req / 15 phút / IP  (trước là 200 — quá thấp, 1 user load
//             trang + socket polling + fetch data dễ chạm ngưỡng này)
//
//  auth     : 10 req / 15 phút / IP   (giữ nguyên — chống brute force login)
//
//  spin     : 10 req / 60s / IP       (tăng từ 5 → 10, tránh false-positive
//             khi animation re-mount gửi request 2 lần)
//
//  deposit  : 5 req / 60s / IP        (tăng từ 3 → 5, tránh bị chặn khi user
//             bấm lại do mạng chậm)
//
module.exports = {
  global:  createLimiter(15 * 60 * 1000, 500, 'Quá nhiều yêu cầu, thử lại sau'),
  auth:    createLimiter(15 * 60 * 1000, 10,  'Quá nhiều lần đăng nhập, thử lại sau 15 phút'),
  spin:    createLimiter(60 * 1000,       10,  'Quay quá nhanh, thử lại sau'),
  deposit: createLimiter(60 * 1000,       5,   'Tạo quá nhiều lệnh nạp tiền, thử lại sau'),
  bid:     createLimiter(60 * 1000,       20,  'Đặt giá quá nhanh, thử lại sau'),
};