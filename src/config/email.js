const nodemailer = require('nodemailer')
const logger = require('./logger')

let transporter = null

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  }
  return transporter
}

const sendMail = async ({ to, subject, html, text }) => {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      logger.warn('Email not configured — skipping send')
      return false
    }
    const t = getTransporter()
    await t.sendMail({
      from: process.env.SMTP_FROM || `"AOV Shop" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      text,
    })
    logger.info(`Email sent to ${to}: ${subject}`)
    return true
  } catch (err) {
    logger.error('Email send error:', err.message)
    return false
  }
}

// ── Notify admin: new quan huy topup order ────────────────────
const notifyAdminTopupOrder = async ({ order, user, pkg }) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER
  if (!adminEmail) return

  const statusColor = '#f59e0b'
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Arial', sans-serif; background: #0a0a12; color: #e2e8f0; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #14141f; border-radius: 16px; overflow: hidden; border: 1px solid rgba(255,45,115,0.2); }
        .header { background: linear-gradient(135deg, #ff2d73, #8b5cf6); padding: 30px; text-align: center; }
        .header h1 { color: white; margin: 0; font-size: 24px; font-weight: 900; letter-spacing: 2px; }
        .body { padding: 30px; }
        .badge { display: inline-block; background: ${statusColor}22; border: 1px solid ${statusColor}66; color: ${statusColor}; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: bold; margin-bottom: 20px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 20px 0; }
        .info-box { background: #1a1a2e; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 14px; }
        .info-box .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
        .info-box .value { font-size: 16px; font-weight: bold; color: #e2e8f0; }
        .highlight { color: #ff2d73; }
        .quan-huy { color: #a78bfa; font-size: 20px; font-weight: 900; }
        .btn { display: block; text-align: center; background: linear-gradient(135deg, #ff2d73, #8b5cf6); color: white !important; padding: 14px 30px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 15px; margin: 24px 0 0; }
        .footer { text-align: center; padding: 20px 30px; font-size: 12px; color: #475569; border-top: 1px solid rgba(255,255,255,0.05); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>⚔️ ĐƠN NẠP QUÂN HUY MỚI</h1>
        </div>
        <div class="body">
          <span class="badge">⏳ Chờ Xử Lý</span>
          <p style="color:#94a3b8;margin-bottom:20px;">Có một đơn nạp Quân Huy mới cần được xử lý. Vui lòng đăng nhập Admin Panel để xác nhận.</p>
          
          <div class="info-grid">
            <div class="info-box">
              <div class="label">Mã đơn</div>
              <div class="value highlight">#${order.orderCode}</div>
            </div>
            <div class="info-box">
              <div class="label">Người dùng</div>
              <div class="value">${user.displayName || user.username}</div>
            </div>
            <div class="info-box">
              <div class="label">Email</div>
              <div class="value" style="font-size:13px">${user.email}</div>
            </div>
            <div class="info-box">
              <div class="label">Gói nạp</div>
              <div class="value">${pkg.name}</div>
            </div>
            <div class="info-box">
              <div class="label">Quân Huy</div>
              <div class="quan-huy">⚔️ ${pkg.quanHuyAmount + pkg.bonusQuanHuy}</div>
            </div>
            <div class="info-box">
              <div class="label">Chi phí</div>
              <div class="value highlight">${parseInt(pkg.price).toLocaleString('vi-VN')}đ</div>
            </div>
            <div class="info-box">
              <div class="label">ID Game</div>
              <div class="value" style="font-family:monospace">${order.gamePlayerId}</div>
            </div>
            <div class="info-box">
              <div class="label">Server</div>
              <div class="value">${order.gameServer || 'Không có'}</div>
            </div>
          </div>

          ${order.note ? `<div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:14px;margin-top:12px;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Ghi chú của user</div><div style="color:#cbd5e1;">${order.note}</div></div>` : ''}
          
          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/topup" class="btn">
            → Vào Admin Để Xử Lý Ngay
          </a>
        </div>
        <div class="footer">
          LQ Shop Admin System · ${new Date().toLocaleString('vi-VN')}
        </div>
      </div>
    </body>
    </html>
  `

  await sendMail({
    to: adminEmail,
    subject: `⚔️ [LQ Shop] Đơn nạp Quân Huy mới #${order.orderCode} — ${user.username}`,
    html,
    text: `Đơn nạp Quân Huy mới: #${order.orderCode} | User: ${user.username} | Gói: ${pkg.name} | QH: ${pkg.quanHuyAmount + pkg.bonusQuanHuy} | Cần xử lý tại: ${process.env.FRONTEND_URL}/admin/topup`,
  })
}

// ── Notify user: topup order completed ──────────────────────
const notifyUserTopupCompleted = async ({ order, user, pkg, totalQuanHuy }) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; background: #0a0a12; color: #e2e8f0; margin: 0; padding: 20px; }
        .container { max-width: 540px; margin: 0 auto; background: #14141f; border-radius: 16px; overflow: hidden; border: 1px solid rgba(139,92,246,0.3); }
        .header { background: linear-gradient(135deg, #8b5cf6, #6d28d9); padding: 30px; text-align: center; }
        .header h1 { color: white; margin: 0; font-size: 22px; font-weight: 900; }
        .body { padding: 30px; text-align: center; }
        .big-number { font-size: 56px; font-weight: 900; color: #a78bfa; margin: 16px 0; text-shadow: 0 0 20px rgba(167,139,250,0.6); }
        .info { background: #1a1a2e; border-radius: 10px; padding: 16px; margin: 20px 0; text-align: left; }
        .info div { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px; }
        .info div:last-child { border-bottom: none; }
        .label { color: #64748b; }
        .value { color: #e2e8f0; font-weight: bold; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #475569; border-top: 1px solid rgba(255,255,255,0.05); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header"><h1>⚔️ Nạp Quân Huy Thành Công!</h1></div>
        <div class="body">
          <p style="color:#94a3b8;">Đơn nạp Quân Huy của bạn đã được xử lý thành công</p>
          <div class="big-number">+${totalQuanHuy} ⚔️</div>
          <div class="info">
            <div><span class="label">Mã đơn</span><span class="value" style="color:#a78bfa">#${order.orderCode}</span></div>
            <div><span class="label">Gói nạp</span><span class="value">${pkg.name}</span></div>
            <div><span class="label">ID Game</span><span class="value" style="font-family:monospace">${order.gamePlayerId}</span></div>
            <div><span class="label">Quân Huy nhận</span><span class="value" style="color:#a78bfa">⚔️ ${totalQuanHuy}</span></div>
          </div>
          <p style="color:#64748b;font-size:13px;">Quân Huy đã được cộng vào tài khoản của bạn.</p>
        </div>
        <div class="footer">LQ Shop · ${new Date().toLocaleString('vi-VN')}</div>
      </div>
    </body>
    </html>
  `

  await sendMail({
    to: user.email,
    subject: `⚔️ [LQ Shop] Nạp Quân Huy thành công — +${totalQuanHuy} Quân Huy`,
    html,
    text: `Đơn nạp Quân Huy #${order.orderCode} đã hoàn thành. Bạn nhận được +${totalQuanHuy} Quân Huy.`,
  })
}

module.exports = { sendMail, notifyAdminTopupOrder, notifyUserTopupCompleted }
