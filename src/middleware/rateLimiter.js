const rateLimit = require('express-rate-limit');

// ─── Helper: tạo limiter theo IP thực (hoạt động đúng sau nginx/proxy) ────────
const createLimiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    message: { success: false, message },
    standardHeaders: true,   // trả header RateLimit-* (RFC 6585)
    legacyHeaders: false,

    // ⚡ Quan trọng khi deploy sau nginx/cloudflare:
    // Đọc IP thật từ X-Forwarded-For thay vì IP của proxy
    // Phải bật app.set('trust proxy', 1) trong server.js
    keyGenerator: (req) => {
      return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.ip
      );
    },

    // Bỏ qua rate limit cho ADMIN — admin thao tác nhiều trên dashboard
    skip: (req) => {
      return req.user?.role === 'ADMIN';
    },
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
};