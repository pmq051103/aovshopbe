const logger = require('./logger')
const prisma = require('./prisma')

let _cachedLogo = null
let _logoFetchedAt = 0

const getSiteLogo = async () => {
  if (_cachedLogo && Date.now() - _logoFetchedAt < 5 * 60 * 1000) return _cachedLogo
  try {
    const setting = await prisma.siteConfig.findUnique({ where: { key: 'site_logo' } })
    _cachedLogo = setting?.value || null
    _logoFetchedAt = Date.now()
  } catch (e) {
    logger.error('Get site logo error:', e.message)
    _cachedLogo = null
  }
  return _cachedLogo
}

const sendMail = async ({ to, subject, html, text }) => {
  try {
    const apiKey = process.env.BREVO_API_KEY
    console.log('[Brevo] apiKey exists:', !!apiKey, '| key prefix:', apiKey ? apiKey.substring(0, 10) : 'none')
    if (!apiKey) {
      logger.warn('Email not configured — skipping send')
      return false
    }

    const fromRaw = process.env.SMTP_FROM || 'AOV Shop <pmquang05112003@gmail.com>'
    // Parse "Name <email>" format
    const match = fromRaw.match(/^(.+?)<(.+?)>$/)
    const senderName = match ? match[1].trim() : 'AOV Shop'
    const senderEmail = match ? match[2].trim() : 'pmquang05112003@gmail.com'

    console.log('[Brevo] Sending to:', to, '| from:', senderEmail)
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      logger.error('Email send error:', JSON.stringify(data))
      console.error('[Brevo] Error:', JSON.stringify(data))
      return false
    }

    console.log('[Brevo] Success:', JSON.stringify(data))
    logger.info(`Email sent to ${to}: ${subject}`)
    return true
  } catch (err) {
    logger.error('Email send error:', err.message)
    console.error('[Brevo] Catch:', err.message)
    return false
  }
}

const formatMoney = value => `${parseInt(value || 0).toLocaleString('vi-VN')}đ`

const baseEmail = ({ logo, title, subtitle, badge, content, footerText }) => `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;color:#172033;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e6f0;">

          <!-- HEADER -->
          <tr>
            <td style="background:linear-gradient(135deg,#fff1f7 0%,#f3edff 55%,#eef3ff 100%);padding:40px 36px 32px;text-align:center;">
              ${logo ? `<img src="${logo}" alt="AOV Shop" width="140" height="auto" style="display:block;margin:0 auto 20px;border:0;" />` : ''}
              <h1 style="margin:0;font-size:26px;font-weight:900;color:#172033;line-height:1.3;">${title}</h1>
              ${subtitle ? `<p style="margin:14px auto 0;max-width:460px;font-size:14px;line-height:1.7;color:#6b7a99;">${subtitle}</p>` : ''}
              ${badge ? `
              <table cellpadding="0" cellspacing="0" border="0" style="margin:20px auto 0;">
                <tr><td style="background:#fff8ec;border:1px solid #ffd59a;border-radius:999px;padding:8px 20px;font-size:13px;font-weight:800;color:#c97a10;">${badge}</td></tr>
              </table>` : ''}
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:32px 36px;">
              ${content}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#f8f9ff;border-top:1px solid #e8eaf0;padding:20px 36px;text-align:center;">
              <p style="margin:0 0 4px;font-size:14px;font-weight:800;color:#52617a;">🛡️ AOV Shop</p>
              <p style="margin:0;font-size:12px;color:#8a94a8;">${footerText || `Ngày ${new Date().toLocaleString('vi-VN')}`}</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

const infoCard = items => `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e6f0;border-radius:14px;overflow:hidden;">
    ${items.map((item, i) => `
    <tr style="${i !== 0 ? 'border-top:1px solid #eef0f6;' : ''}">
      <td style="padding:16px 18px;${i !== 0 ? 'border-top:1px solid #eef0f6;' : ''}">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="48" valign="middle" style="padding-right:14px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr><td style="width:44px;height:44px;background:${item.bg || '#f4f6ff'};border-radius:12px;text-align:center;font-size:20px;line-height:44px;">${item.icon}</td></tr>
              </table>
            </td>
            <td valign="middle">
              <p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#8791a6;">${item.label}</p>
              <p style="margin:0;font-size:15px;font-weight:900;color:${item.color || '#172033'};word-break:break-word;">${item.value}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('')}
  </table>
`

const notifyAdminTopupOrder = async ({ order, user, pkg }) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER
  if (!adminEmail) return

  const logo = await getSiteLogo()
  const totalQH = Number(pkg.quanHuyAmount || 0) + Number(pkg.bonusQuanHuy || 0)
  const adminUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/topup`

  const content = `
    <p style="margin:0 0 8px;font-size:15px;line-height:1.7;color:#344054;">Có một đơn nạp Quân Huy mới cần được xử lý.</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#344054;">Vui lòng đăng nhập Admin Panel để xác nhận.</p>

    ${infoCard([
      { icon: '📄', label: 'Mã đơn', value: '#' + order.orderCode, color: '#ec2f75', bg: '#fff0f6' },
      { icon: '👤', label: 'Người dùng', value: user.displayName || user.username, bg: '#f4f0ff' },
      { icon: '✉️', label: 'Email', value: user.email || 'Không có', color: '#1976d2', bg: '#edf6ff' },
      { icon: '🎁', label: 'Gói nạp', value: pkg.name, bg: '#f0fff8' },
      { icon: '⚔️', label: 'Quân Huy', value: totalQH.toLocaleString('vi-VN'), color: '#7c3aed', bg: '#f4f0ff' },
      { icon: '💰', label: 'Chi phí', value: formatMoney(pkg.price), color: '#ec2f75', bg: '#fff3ea' },
      { icon: '🎮', label: 'ID Game', value: order.gamePlayerId, bg: '#eef9ff' },
      { icon: '🗄️', label: 'Server', value: order.gameServer || 'Không có', bg: '#f3f6fb' },
      { icon: '📝', label: 'Ghi chú', value: order.note || 'Không có ghi chú', bg: '#f8fafc' },
    ])}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr><td align="center" style="background:linear-gradient(135deg,#ec2f75,#7c3aed);border-radius:12px;">
        <a href="${adminUrl}" style="display:block;padding:16px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:900;">→ Vào Admin để xử lý ngay</a>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
      <tr><td style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px 18px;font-size:13px;color:#41516a;line-height:1.7;">
        <b>Lưu ý:</b> Vui lòng xử lý đơn hàng sớm nhất để đảm bảo trải nghiệm tốt cho khách hàng.
      </td></tr>
    </table>
  `

  const html = baseEmail({
    logo,
    title: '⚔️ ĐƠN NẠP QUÂN HUY MỚI',
    subtitle: 'Có một đơn nạp Quân Huy mới cần được xử lý.',
    badge: '⏳ CHỜ XỬ LÝ',
    content,
  })

  await sendMail({
    to: adminEmail,
    subject: `⚔️ [AOV Shop] Đơn nạp Quân Huy mới #${order.orderCode} — ${user.username}`,
    html,
    text: `Đơn nạp Quân Huy mới: #${order.orderCode} | User: ${user.username} | Gói: ${pkg.name} | QH: ${totalQH} | Xử lý tại: ${adminUrl}`,
  })
}

const notifyUserTopupCompleted = async ({ order, user, pkg, totalQuanHuy }) => {
  const logo = await getSiteLogo()

  const content = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr><td align="center">
        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
          <tr><td style="width:70px;height:70px;background:#22c55e;border-radius:50%;text-align:center;font-size:36px;line-height:70px;color:white;">✓</td></tr>
        </table>
        <h2 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#172033;">Nạp Quân Huy <span style="color:#16a34a;">thành công!</span></h2>
        <p style="margin:0;font-size:14px;color:#6b7a99;">Đơn nạp Quân Huy của bạn đã được xử lý thành công.</p>
      </td></tr>
    </table>

    ${infoCard([
      { icon: '📄', label: 'Mã đơn', value: '#' + order.orderCode, color: '#7c3aed', bg: '#f4f0ff' },
      { icon: '🎁', label: 'Gói nạp', value: pkg.name, bg: '#f0fff8' },
      { icon: '⚔️', label: 'Quân Huy nhận', value: totalQuanHuy.toLocaleString('vi-VN'), color: '#7c3aed', bg: '#f4f0ff' },
      { icon: '🎮', label: 'ID Game', value: order.gamePlayerId, bg: '#eef9ff' },
    ])}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
      <tr><td style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:12px;padding:16px 18px;font-size:13px;color:#166534;text-align:center;">
        ✅ Quân Huy đã được cộng vào tài khoản của bạn.
      </td></tr>
    </table>
  `

  const html = baseEmail({
    logo,
    title: 'Nạp Quân Huy thành công!',
    subtitle: 'Cảm ơn bạn đã sử dụng dịch vụ tại AOV Shop.',
    badge: null,
    content,
    footerText: 'Cảm ơn bạn đã sử dụng dịch vụ tại AOV Shop!',
  })

  await sendMail({
    to: user.email,
    subject: `⚔️ [AOV Shop] Nạp Quân Huy thành công — +${totalQuanHuy} Quân Huy`,
    html,
    text: `Đơn nạp Quân Huy #${order.orderCode} đã hoàn thành. Bạn nhận được +${totalQuanHuy} Quân Huy.`,
  })
}

const sendResetPasswordEmail = async ({ user, resetUrl }) => {
  const logo = await getSiteLogo()

  const content = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      <tr><td align="center">
        <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
          <tr><td style="width:70px;height:70px;background:linear-gradient(135deg,#ec2f75,#7c3aed);border-radius:50%;text-align:center;font-size:28px;line-height:70px;">🔐</td></tr>
        </table>
        <h2 style="margin:0 0 8px;font-size:22px;font-weight:900;color:#172033;">Yêu cầu đặt lại mật khẩu</h2>
        <p style="margin:0;font-size:14px;color:#6b7a99;">Xin chào <b>${user.displayName || user.username}</b>, bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản AOV Shop.</p>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
      <tr><td align="center" style="background:linear-gradient(135deg,#ec2f75,#7c3aed);border-radius:12px;">
        <a href="${resetUrl}" style="display:block;padding:16px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:900;">→ Đặt lại mật khẩu ngay</a>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
      <tr><td style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 16px;font-size:13px;color:#9a3412;line-height:1.7;">
        ⏰ Link đặt lại mật khẩu sẽ hết hạn sau <b>1 giờ</b>.
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;">
      <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;font-size:12px;color:#475569;line-height:1.7;">
        Nếu nút không hoạt động, copy link này:<br/>
        <a href="${resetUrl}" style="color:#7c3aed;word-break:break-all;">${resetUrl}</a>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px 16px;font-size:13px;color:#1e40af;line-height:1.7;">
        🛡️ Nếu bạn không yêu cầu đổi mật khẩu, hãy bỏ qua email này.
      </td></tr>
    </table>
  `

  const html = baseEmail({
    logo,
    title: '🔐 ĐẶT LẠI MẬT KHẨU',
    subtitle: 'Bạn đang yêu cầu tạo mật khẩu mới cho tài khoản AOV Shop.',
    badge: 'BẢO MẬT TÀI KHOẢN',
    content,
    footerText: 'Email bảo mật từ AOV Shop',
  })

  return sendMail({
    to: user.email,
    subject: '🔐 [AOV Shop] Đặt lại mật khẩu tài khoản',
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
