const nodemailer = require('nodemailer')
const logger = require('./logger')
const prisma = require('./prisma')

let transporter = null
let _cachedLogo = null
let _logoFetchedAt = 0

const getSiteLogo = async () => {
  if (_cachedLogo && Date.now() - _logoFetchedAt < 5 * 60 * 1000) {
    return _cachedLogo
  }

  try {
    const setting = await prisma.siteConfig.findUnique({
      where: { key: 'site_logo' },
    })

    _cachedLogo = setting?.value || null
    _logoFetchedAt = Date.now()
  } catch (e) {
    logger.error('Get site logo error:', e.message)
    _cachedLogo = null
  }

  return _cachedLogo
}

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_PORT) === '465',
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

    await getTransporter().sendMail({
      from: `"LQ Shop" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
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

const formatMoney = value =>
  `${parseInt(value || 0).toLocaleString('vi-VN')}đ`

const baseEmail = ({ logo, title, subtitle, badge, content, footerText }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
  <div style="width:100%;padding:28px 12px;background:#f6f7fb;">
    <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e8eaf3;border-radius:22px;overflow:hidden;box-shadow:0 18px 50px rgba(20,25,40,.08);">
      
      <div style="background:linear-gradient(135deg,#fff1f7 0%,#f7edff 55%,#eef5ff 100%);padding:42px 36px 32px;text-align:center;">
        ${
          logo
            ? `<img src="${logo}" alt="AOV Shop" width="150" style="display:block;margin:0 auto 24px;width:150px;max-width:150px;height:auto;border:0;outline:none;" />`
            : ''
        }
        <h1 style="margin:0;font-size:30px;line-height:1.25;font-weight:900;letter-spacing:.5px;color:#172033;">
          ${title}
        </h1>
        ${
          subtitle
            ? `<p style="margin:18px auto 0;max-width:540px;font-size:15px;line-height:1.7;color:#69758c;">${subtitle}</p>`
            : ''
        }
        ${
          badge
            ? `<div style="display:inline-block;margin-top:22px;padding:10px 22px;border-radius:999px;background:#fff8ec;border:1px solid #ffd59a;color:#d78111;font-size:14px;font-weight:800;">${badge}</div>`
            : ''
        }
      </div>

      <div style="padding:34px 38px 36px;">
        ${content}
      </div>

      <div style="padding:24px 36px;background:#fafbff;border-top:1px solid #eef0f6;text-align:center;">
        <div style="font-size:15px;font-weight:800;color:#52617a;margin-bottom:8px;">🛡️ LQ Shop Admin System</div>
        <div style="font-size:13px;color:#8a94a8;">${footerText || `Ngày ${new Date().toLocaleString('vi-VN')}`}</div>
      </div>
    </div>
  </div>
</body>
</html>
`

const infoCard = items => `
  <div style="background:#ffffff;border:1px solid #e8eaf3;border-radius:18px;overflow:hidden;box-shadow:0 12px 30px rgba(20,25,40,.06);">
    ${items.map((item, index) => `
      <div style="display:flex;gap:16px;padding:20px 22px;${index !== items.length - 1 ? 'border-bottom:1px solid #eef0f6;' : ''}">
        <div style="width:44px;height:44px;border-radius:14px;background:${item.bg || '#f4f6ff'};display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">
          ${item.icon}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:#8791a6;margin-bottom:6px;">
            ${item.label}
          </div>
          <div style="font-size:16px;font-weight:900;color:${item.color || '#172033'};line-height:1.4;word-break:break-word;">
            ${item.value}
          </div>
        </div>
      </div>
    `).join('')}
  </div>
`

const notifyAdminTopupOrder = async ({ order, user, pkg }) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER
  if (!adminEmail) return

  const logo = await getSiteLogo()
  const totalQH = Number(pkg.quanHuyAmount || 0) + Number(pkg.bonusQuanHuy || 0)
  const adminUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/topup`

  const content = `
    <p style="margin:0 0 10px;font-size:16px;line-height:1.7;color:#344054;">
      Có một đơn nạp Quân Huy mới cần được xử lý.
    </p>
    <p style="margin:0 0 28px;font-size:16px;line-height:1.7;color:#344054;">
      Vui lòng đăng nhập Admin Panel để xác nhận.
    </p>

    ${infoCard([
      { icon: '📄', label: 'Mã đơn', value: `#${order.orderCode}`, color: '#ec2f75', bg: '#fff0f6' },
      { icon: '👤', label: 'Người dùng', value: user.displayName || user.username, bg: '#f4f0ff' },
      { icon: '✉️', label: 'Email', value: user.email || 'Không có', color: '#1976d2', bg: '#edf6ff' },
      { icon: '🎁', label: 'Gói nạp', value: pkg.name, bg: '#f0fff8' },
      { icon: '⚔️', label: 'Quân Huy', value: totalQH.toLocaleString('vi-VN'), color: '#7c3aed', bg: '#f4f0ff' },
      { icon: '💰', label: 'Chi phí', value: formatMoney(pkg.price), color: '#ec2f75', bg: '#fff3ea' },
      { icon: '🎮', label: 'ID Game', value: order.gamePlayerId, bg: '#eef9ff' },
      { icon: '🗄️', label: 'Server', value: order.gameServer || 'Không có', bg: '#f3f6fb' },
      { icon: '📝', label: 'Ghi chú của user', value: order.note || 'Không có ghi chú', bg: '#f8fafc' },
    ])}

    <a href="${adminUrl}" style="display:block;margin-top:28px;padding:18px 24px;border-radius:14px;background:linear-gradient(135deg,#ec2f75,#7c3aed);color:#ffffff;text-decoration:none;text-align:center;font-size:16px;font-weight:900;letter-spacing:.3px;">
      → Vào Admin để xử lý ngay
    </a>

    <div style="margin-top:24px;padding:18px 20px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;color:#41516a;font-size:14px;line-height:1.7;">
      <b>Lưu ý:</b> Vui lòng xử lý đơn hàng trong thời gian sớm nhất để đảm bảo trải nghiệm tốt cho khách hàng.
    </div>
  `

  const html = baseEmail({
    logo,
    title: '⚔️ ĐƠN NẠP QUÂN HUY MỚI',
    subtitle: 'Có một đơn nạp Quân Huy mới cần được xử lý. Vui lòng đăng nhập Admin Panel để xác nhận.',
    badge: '⏳ CHỜ XỬ LÝ',
    content,
  })

  await sendMail({
    to: adminEmail,
    subject: `⚔️ [LQ Shop] Đơn nạp Quân Huy mới #${order.orderCode} — ${user.username}`,
    html,
    text: `Đơn nạp Quân Huy mới: #${order.orderCode} | User: ${user.username} | Gói: ${pkg.name} | QH: ${totalQH} | Cần xử lý tại: ${adminUrl}`,
  })
}

const notifyUserTopupCompleted = async ({ order, user, pkg, totalQuanHuy }) => {
  const logo = await getSiteLogo()

  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="width:74px;height:74px;margin:0 auto 18px;border-radius:50%;background:#22c55e;color:white;font-size:42px;line-height:74px;font-weight:900;">
        ✓
      </div>
      <h2 style="margin:0;font-size:26px;line-height:1.35;color:#172033;">
        Nạp Quân Huy <span style="color:#16a34a;">thành công!</span>
      </h2>
      <p style="margin:12px auto 0;max-width:460px;font-size:15px;line-height:1.7;color:#69758c;">
        Đơn nạp Quân Huy của bạn đã được xử lý thành công.
      </p>
    </div>

    ${infoCard([
      { icon: '📄', label: 'Mã đơn', value: `#${order.orderCode}`, color: '#7c3aed', bg: '#f4f0ff' },
      { icon: '🎁', label: 'Gói nạp', value: pkg.name, bg: '#f0fff8' },
      { icon: '⚔️', label: 'Quân Huy nhận', value: totalQuanHuy.toLocaleString('vi-VN'), color: '#7c3aed', bg: '#f4f0ff' },
      { icon: '🎮', label: 'ID Game', value: order.gamePlayerId, bg: '#eef9ff' },
    ])}

    <div style="margin-top:24px;padding:18px 20px;border-radius:14px;background:#ecfdf3;border:1px solid #bbf7d0;color:#166534;font-size:14px;line-height:1.7;text-align:center;">
      ✅ Quân Huy đã được cộng vào tài khoản của bạn.
    </div>
  `

  const html = baseEmail({
    logo,
    title: 'Nạp Quân Huy thành công!',
    subtitle: 'Cảm ơn bạn đã sử dụng dịch vụ tại LQ Shop.',
    badge: null,
    content,
    footerText: 'Cảm ơn bạn đã sử dụng dịch vụ tại LQ Shop!',
  })

  await sendMail({
    to: user.email,
    subject: `⚔️ [LQ Shop] Nạp Quân Huy thành công — +${totalQuanHuy} Quân Huy`,
    html,
    text: `Đơn nạp Quân Huy #${order.orderCode} đã hoàn thành. Bạn nhận được +${totalQuanHuy} Quân Huy.`,
  })
}

const sendResetPasswordEmail = async ({ user, resetUrl }) => {
  const logo = await getSiteLogo()

  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="width:74px;height:74px;margin:0 auto 18px;border-radius:50%;background:linear-gradient(135deg,#ec2f75,#7c3aed);color:white;font-size:34px;line-height:74px;font-weight:900;">
        🔐
      </div>

      <h2 style="margin:0;font-size:26px;line-height:1.35;color:#172033;">
        Yêu cầu đặt lại mật khẩu
      </h2>

      <p style="margin:12px auto 0;max-width:480px;font-size:15px;line-height:1.7;color:#69758c;">
        Xin chào <b>${user.displayName || user.username}</b>, bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản LQ Shop.
      </p>
    </div>

    <a href="${resetUrl}" style="display:block;margin:28px 0;padding:18px 24px;border-radius:14px;background:linear-gradient(135deg,#ec2f75,#7c3aed);color:#ffffff;text-decoration:none;text-align:center;font-size:16px;font-weight:900;letter-spacing:.3px;">
      → Đặt lại mật khẩu ngay
    </a>

    <div style="margin-top:22px;padding:18px 20px;border-radius:14px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:14px;line-height:1.7;">
      ⏰ Link đặt lại mật khẩu sẽ hết hạn sau <b>1 giờ</b>.
    </div>

    <div style="margin-top:18px;padding:18px 20px;border-radius:14px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:13px;line-height:1.7;">
      Nếu nút không hoạt động, bạn có thể copy link này:
      <br />
      <a href="${resetUrl}" style="color:#7c3aed;word-break:break-all;">${resetUrl}</a>
    </div>

    <div style="margin-top:18px;padding:18px 20px;border-radius:14px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;font-size:14px;line-height:1.7;">
      🛡️ Nếu bạn không yêu cầu đổi mật khẩu, hãy bỏ qua email này. Mật khẩu của bạn vẫn được giữ nguyên.
    </div>
  `

  const html = baseEmail({
    logo,
    title: '🔐 ĐẶT LẠI MẬT KHẨU',
    subtitle: 'Bạn đang yêu cầu tạo mật khẩu mới cho tài khoản LQ Shop.',
    badge: 'BẢO MẬT TÀI KHOẢN',
    content,
    footerText: 'Email bảo mật từ LQ Shop',
  })

  return sendMail({
    to: user.email,
    subject: '🔐 [LQ Shop] Đặt lại mật khẩu tài khoản',
    html,
    text: `Xin chào ${user.displayName || user.username}, mở link sau để đặt lại mật khẩu: ${resetUrl}. Link hết hạn sau 1 giờ.`,
  })
}

module.exports = {
  sendMail,
  notifyAdminTopupOrder,
  notifyUserTopupCompleted,
  sendResetPasswordEmail,
}