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

const BRAND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

const baseEmail = ({ logo, title, subtitle, badge, content, footerText }) => `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
</head>
<body style="margin:0;padding:0;background:#eef1f7;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#1a2233;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background:#eef1f7;padding:36px 12px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:600px;width:100%;background:#ffffff;border-radius:22px;overflow:hidden;border:1px solid #e3e7f1;">

          <!-- ACCENT BAR -->
          <tr><td style="height:6px;background:linear-gradient(90deg,#ec2f75,#7c3aed);font-size:0;line-height:0;">&nbsp;</td></tr>

          <!-- HEADER -->
          <tr>
            <td style="background:linear-gradient(135deg,#fff1f7 0%,#f3edff 55%,#eef3ff 100%);padding:38px 36px 30px;text-align:center;">
              ${logo ? `<img src="${logo}" alt="AOV Shop" width="132" height="auto" style="display:block;margin:0 auto 18px;border:0;" />` : ''}
              <h1 style="margin:0;font-size:24px;font-weight:900;color:#1a2233;line-height:1.35;letter-spacing:.2px;">${title}</h1>
              ${subtitle ? `<p style="margin:12px auto 0;max-width:440px;font-size:14px;line-height:1.7;color:#6b7689;">${subtitle}</p>` : ''}
              ${badge ? `
              <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:18px auto 0;">
                <tr><td style="background:#ffffff;border:1px solid #e7d7fb;border-radius:999px;padding:7px 18px;font-size:12px;font-weight:800;letter-spacing:.5px;color:#7c3aed;">${badge}</td></tr>
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
            <td style="background:#f7f8fc;border-top:1px solid #e8eaf2;padding:24px 36px;text-align:center;">
              <p style="margin:0 0 6px;font-size:15px;font-weight:900;color:#1a2233;letter-spacing:.3px;">AOV Shop</p>
              <p style="margin:0 0 12px;font-size:12px;color:#8a94a8;line-height:1.6;">${footerText || `Cảm ơn bạn đã đồng hành cùng AOV Shop.`}</p>
              <p style="margin:0 0 4px;font-size:12px;color:#9aa3b5;">Cần hỗ trợ? Truy cập <a href="${BRAND_URL}" style="color:#7c3aed;text-decoration:none;font-weight:700;">website của chúng tôi</a>.</p>
              <p style="margin:0;font-size:11px;color:#b3bbc9;">Đây là email tự động, vui lòng không trả lời. © ${new Date().getFullYear()} AOV Shop.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`

// Bảng thông tin: label trái – value phải, có dải màu nhấn bên trái mỗi hàng
const infoCard = items => `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border:1px solid #e7eaf2;border-radius:14px;overflow:hidden;background:#fcfcff;">
    ${items.map((item, i) => `
    <tr>
      <td style="${i !== 0 ? 'border-top:1px solid #eef0f6;' : ''}padding:0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>
            <td width="4" style="background:${item.color || '#cbd2e0'};font-size:0;line-height:0;">&nbsp;</td>
            <td style="padding:14px 18px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                <tr>
                  <td valign="middle" style="font-size:12px;font-weight:700;color:#8791a6;">${item.label}</td>
                  <td valign="middle" align="right" style="font-size:15px;font-weight:800;color:${item.color || '#1a2233'};word-break:break-word;padding-left:12px;">${item.value}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('')}
  </table>
`

// Khối làm nổi giá trị chính (số tiền / Quân Huy)
const heroBlock = ({ label, value, sub, color }) => `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 24px;">
    <tr><td align="center" style="background:linear-gradient(135deg,#fff1f7,#f3edff);border:1px solid #efe2fb;border-radius:16px;padding:26px 24px;">
      <p style="margin:0 0 8px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8791a6;font-weight:800;">${label}</p>
      <p style="margin:0;font-size:34px;font-weight:900;color:${color || '#7c3aed'};line-height:1.05;">${value}</p>
      ${sub ? `<p style="margin:10px 0 0;font-size:13px;color:#6b7689;">${sub}</p>` : ''}
    </td></tr>
  </table>
`

// Nút CTA chống vỡ trên Outlook (VML fallback)
const ctaButton = (url, label) => `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 8px;">
    <tr><td align="center">
      <!--[if mso]>
      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:50px;v-text-anchor:middle;width:340px;" arcsize="24%" fillcolor="#7c3aed" stroke="f">
      <w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center>
      </v:roundrect>
      <![endif]-->
      <!--[if !mso]><!-->
      <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#ec2f75,#7c3aed);color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:15px 38px;border-radius:12px;">${label}</a>
      <!--<![endif]-->
    </td></tr>
  </table>
`

// Hộp ghi chú nhiều tông màu
const noticeBox = (text, tone = 'info') => {
  const tones = {
    info: { bg: '#eef4ff', border: '#cfe0ff', color: '#33508a' },
    warn: { bg: '#fff7ed', border: '#fed7aa', color: '#9a3412' },
    success: { bg: '#ecfdf3', border: '#bbf7d0', color: '#166534' },
    secure: { bg: '#f5f3ff', border: '#ddd0fb', color: '#5b34c4' },
  }
  const t = tones[tone] || tones.info
  return `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:16px;">
    <tr><td style="background:${t.bg};border:1px solid ${t.border};border-radius:12px;padding:14px 16px;font-size:13px;color:${t.color};line-height:1.7;">${text}</td></tr>
  </table>`
}

// Vòng tròn dấu tích cho email thành công
const checkCircle = () => `
  <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 auto 18px;">
    <tr><td style="width:66px;height:66px;background:#22c55e;border-radius:50%;text-align:center;vertical-align:middle;font-size:34px;line-height:66px;color:#ffffff;font-family:Arial,sans-serif;">✓</td></tr>
  </table>
`

const notifyAdminTopupOrder = async ({ order, user, pkg }) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER
  if (!adminEmail) return

  const logo = await getSiteLogo()
  const totalQH = Number(pkg.quanHuyAmount || 0) + Number(pkg.bonusQuanHuy || 0)
  const adminUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/topup`

  const content = `
    <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#344054;text-align:center;">Có một đơn nạp Quân Huy mới đang chờ bạn xác nhận trong Admin Panel.</p>

    ${heroBlock({
      label: 'Quân Huy cần nạp',
      value: totalQH.toLocaleString('vi-VN'),
      sub: `Gói ${pkg.name} • ${formatMoney(pkg.price)}`,
      color: '#7c3aed',
    })}

    ${infoCard([
      { label: 'Mã đơn', value: '#' + order.orderCode, color: '#ec2f75' },
      { label: 'Người dùng', value: user.displayName || user.username },
      { label: 'Email', value: user.email || 'Không có', color: '#1976d2' },
      { label: 'Chi phí', value: formatMoney(pkg.price), color: '#ec2f75' },
      { label: 'ID Game', value: order.gamePlayerId },
      { label: 'Server', value: order.gameServer || 'Không có' },
      { label: 'Ghi chú', value: order.note || 'Không có ghi chú' },
    ])}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:24px;"><tr><td>&nbsp;</td></tr></table>
    ${ctaButton(adminUrl, 'Vào Admin xử lý ngay')}

    ${noticeBox('<b>Lưu ý:</b> Vui lòng xử lý đơn hàng sớm nhất để đảm bảo trải nghiệm tốt cho khách hàng.', 'info')}
  `

  const html = baseEmail({
    logo,
    title: 'ĐƠN NẠP QUÂN HUY MỚI',
    subtitle: 'Có một đơn nạp Quân Huy mới cần được xử lý.',
    badge: 'CHỜ XỬ LÝ',
    content,
  })

  await sendMail({
    to: adminEmail,
    subject: `[AOV Shop] Đơn nạp Quân Huy mới #${order.orderCode} — ${user.username}`,
    html,
    text: `Đơn nạp Quân Huy mới: #${order.orderCode} | User: ${user.username} | Gói: ${pkg.name} | QH: ${totalQH} | Xử lý tại: ${adminUrl}`,
  })
}

const notifyUserTopupCompleted = async ({ order, user, pkg, totalQuanHuy }) => {
  const logo = await getSiteLogo()

  const content = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-bottom:22px;">
      <tr><td align="center">
        ${checkCircle()}
        <h2 style="margin:0 0 8px;font-size:23px;font-weight:900;color:#1a2233;">Nạp Quân Huy <span style="color:#16a34a;">thành công!</span></h2>
        <p style="margin:0;font-size:14px;color:#6b7689;">Đơn nạp Quân Huy của bạn đã được xử lý thành công.</p>
      </td></tr>
    </table>

    ${heroBlock({
      label: 'Quân Huy đã nhận',
      value: '+' + totalQuanHuy.toLocaleString('vi-VN'),
      sub: pkg.name,
      color: '#16a34a',
    })}

    ${infoCard([
      { label: 'Mã đơn', value: '#' + order.orderCode, color: '#7c3aed' },
      { label: 'Gói nạp', value: pkg.name },
      { label: 'ID Game', value: order.gamePlayerId },
    ])}

    ${noticeBox('Quân Huy đã được cộng vào tài khoản game của bạn. Chúc bạn chơi game vui vẻ!', 'success')}
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
    subject: `[AOV Shop] Nạp Quân Huy thành công — +${totalQuanHuy} Quân Huy`,
    html,
    text: `Đơn nạp Quân Huy #${order.orderCode} đã hoàn thành. Bạn nhận được +${totalQuanHuy} Quân Huy.`,
  })
}

const sendResetPasswordEmail = async ({ user, resetUrl }) => {
  const logo = await getSiteLogo()

  const content = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-bottom:24px;">
      <tr><td align="center">
        <h2 style="margin:0 0 8px;font-size:22px;font-weight:900;color:#1a2233;">Yêu cầu đặt lại mật khẩu</h2>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#6b7689;">Xin chào <b>${user.displayName || user.username}</b>, bạn vừa yêu cầu đặt lại mật khẩu cho tài khoản AOV Shop. Nhấn nút bên dưới để tạo mật khẩu mới.</p>
      </td></tr>
    </table>

    ${ctaButton(resetUrl, 'Đặt lại mật khẩu')}

    ${noticeBox('Link đặt lại mật khẩu sẽ hết hạn sau <b>1 giờ</b> kể từ khi gửi email này.', 'warn')}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:16px;">
      <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;font-size:12px;color:#475569;line-height:1.7;">
        Nếu nút không hoạt động, hãy sao chép đường link sau vào trình duyệt:<br/>
        <a href="${resetUrl}" style="color:#7c3aed;word-break:break-all;">${resetUrl}</a>
      </td></tr>
    </table>

    ${noticeBox('Nếu bạn không yêu cầu đổi mật khẩu, hãy bỏ qua email này. Tài khoản của bạn vẫn an toàn.', 'secure')}
  `

  const html = baseEmail({
    logo,
    title: 'ĐẶT LẠI MẬT KHẨU',
    subtitle: 'Bạn đang yêu cầu tạo mật khẩu mới cho tài khoản AOV Shop.',
    badge: 'BẢO MẬT TÀI KHOẢN',
    content,
    footerText: 'Email bảo mật từ AOV Shop',
  })

  return sendMail({
    to: user.email,
    subject: '[AOV Shop] Đặt lại mật khẩu tài khoản',
    html,
    text: `Xin chào ${user.displayName || user.username}, mở link sau để đặt lại mật khẩu: ${resetUrl}. Link hết hạn sau 1 giờ.`,
  })
}


const sendVerificationCodeEmail = async ({ user, code }) => {
  const logo = await getSiteLogo()

  const content = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-bottom:24px;">
      <tr><td align="center">
        <h2 style="margin:0 0 8px;font-size:22px;font-weight:900;color:#1a2233;">Xác thực địa chỉ email</h2>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#6b7689;">Xin chào <b>${user.displayName || user.username}</b>, dùng mã bên dưới để hoàn tất xác thực tài khoản AOV Shop.</p>
      </td></tr>
    </table>

    ${heroBlock({
      label: 'Mã xác thực',
      value: code.split('').join(' '),
      sub: 'Mã có hiệu lực trong 10 phút',
      color: '#7c3aed',
    })}

    ${noticeBox('Không chia sẻ mã này cho bất kỳ ai, kể cả nhân viên AOV Shop. Nếu bạn không yêu cầu xác thực, hãy bỏ qua email này.', 'warn')}
  `

  const html = baseEmail({
    logo,
    title: 'XÁC THỰC EMAIL',
    subtitle: 'Nhập mã xác thực để kích hoạt tài khoản của bạn.',
    badge: 'BẢO MẬT TÀI KHOẢN',
    content,
    footerText: 'Email bảo mật từ AOV Shop',
  })

  return sendMail({
    to: user.email,
    subject: `[AOV Shop] Mã xác thực email của bạn: ${code}`,
    html,
    text: `Mã xác thực tài khoản AOV Shop của bạn là: ${code}. Mã có hiệu lực trong 10 phút. Không chia sẻ mã này cho bất kỳ ai.`,
  })
}

const notifyUserCardPurchase = async ({ user, cards, telco, denomination, quantity, totalPrice, purchaseId }) => {
  const logo = await getSiteLogo()

  const cardBlocks = (cards || []).map((c, i) => {
    // Đối tác có thể đặt tên field khác nhau tuỳ API — thử lần lượt các tên phổ biến.
    const code = c.code || c.pin || c.card_code || c.cardCode
    const seri = c.serial || c.seri || c.serial_number || c.card_serial || c.cardSerial
    return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:12px;border:1px solid #e7eaf2;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#f6f3ff;padding:8px 16px;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#7c3aed;">Thẻ ${i + 1}</td></tr>
      <tr><td style="padding:14px 16px;">
        ${code ? `<p style="margin:0 0 2px;font-size:11px;color:#8791a6;text-transform:uppercase;letter-spacing:.8px;">Mã thẻ</p>
        <p style="margin:0 0 10px;font-size:19px;font-weight:900;color:#1a2233;font-family:'Courier New',monospace;letter-spacing:2px;">${code}</p>` : ''}
        ${seri ? `<p style="margin:0 0 2px;font-size:11px;color:#8791a6;text-transform:uppercase;letter-spacing:.8px;">Serial</p>
        <p style="margin:0;font-size:14px;font-weight:700;color:#7c3aed;font-family:'Courier New',monospace;">${seri}</p>` : ''}
        ${c.expireDate ? `<p style="margin:8px 0 0;font-size:12px;color:#8791a6;">Hạn sử dụng: ${c.expireDate}</p>` : ''}
      </td></tr>
    </table>`
  }).join('')

  const content = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-bottom:22px;">
      <tr><td align="center">
        ${checkCircle()}
        <h2 style="margin:0 0 8px;font-size:23px;font-weight:900;color:#1a2233;">Mua thẻ <span style="color:#7c3aed;">thành công!</span></h2>
        <p style="margin:0;font-size:14px;color:#6b7689;">Xin chào <b>${user.displayName || user.username}</b>, thẻ của bạn đã sẵn sàng sử dụng.</p>
      </td></tr>
    </table>

    ${heroBlock({
      label: `${telco} • ${formatMoney(denomination)}`,
      value: formatMoney(totalPrice),
      sub: `${quantity} thẻ`,
      color: '#ec2f75',
    })}

    ${infoCard([
      ...(purchaseId ? [{ label: 'Mã giao dịch', value: purchaseId, color: '#1a2233' }] : []),
      { label: 'Loại thẻ', value: telco, color: '#7c3aed' },
      { label: 'Mệnh giá', value: formatMoney(denomination), color: '#ec2f75' },
      { label: 'Số lượng', value: quantity + ' thẻ' },
      { label: 'Tổng tiền', value: formatMoney(totalPrice), color: '#ec2f75' },
    ])}

    ${cards && cards.length > 0 ? `
    <p style="margin:24px 0 0;font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#7c3aed;">Mã thẻ của bạn (${cards.length} thẻ)</p>
    ${cardBlocks}` : ''}

    ${noticeBox('Vui lòng lưu lại mã thẻ và sử dụng sớm. AOV Shop không chịu trách nhiệm nếu mã thẻ bị mất sau khi đã gửi qua email.', 'warn')}
  `

  const html = baseEmail({
    logo,
    title: 'MUA THẺ THÀNH CÔNG',
    subtitle: `${quantity} thẻ ${telco} mệnh giá ${formatMoney(denomination)} đã sẵn sàng.`,
    badge: 'HOÀN THÀNH',
    content,
    footerText: 'Cảm ơn bạn đã sử dụng dịch vụ tại AOV Shop!',
  })

  return sendMail({
    to: user.email,
    subject: `[AOV Shop] Mua thẻ thành công — ${quantity} thẻ ${telco} ${formatMoney(denomination)}`,
    html,
    text: `Mua thẻ thành công! Mã giao dịch: ${purchaseId || ''}. ${quantity} thẻ ${telco} ${formatMoney(denomination)}. Mã thẻ: ${(cards || []).map(c => c.code || c.pin || c.card_code).join(', ')}. Serial: ${(cards || []).map(c => c.serial || c.seri || c.serial_number).filter(Boolean).join(', ')}`,
  })
}


const getAdminEmail = async () => {
  try {
    const setting = await prisma.siteConfig.findUnique({ where: { key: 'admin_email' } })
    return setting?.value || process.env.ADMIN_EMAIL || process.env.SMTP_FROM?.match(/<(.+?)>/)?.[1]
  } catch {
    return process.env.ADMIN_EMAIL || null
  }
}

const formatDateVN = value => value ? new Date(value).toLocaleDateString('vi-VN') : 'Không có'

const notifyLayawayOverdueAdmin = async ({ layaway }) => {
  const adminEmail = await getAdminEmail()
  if (!adminEmail) return false

  const logo = await getSiteLogo()
  const account = layaway.account || {}
  const user = layaway.user || {}
  const adminUrl = `${BRAND_URL}/admin/layaway`

  const content = `
    <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#344054;text-align:center;">
      Đơn đặt cọc/trả góp đã quá hạn thanh toán. Admin cần kiểm tra và xử lý bảo vệ tài khoản game.
    </p>

    ${heroBlock({
      label: 'Còn nợ',
      value: formatMoney(layaway.remainingAmount),
      sub: `Đã trả ${formatMoney(layaway.paidAmount)} / ${formatMoney(layaway.totalPrice)}`,
      color: '#dc2626',
    })}

    ${infoCard([
      { label: 'Mã đơn', value: layaway.layawayCode, color: '#dc2626' },
      { label: 'Mã acc', value: account.code || 'N/A', color: '#7c3aed' },
      { label: 'Tên acc', value: account.title || 'N/A' },
      { label: 'Username game', value: account.gameUsername || 'N/A', color: '#1a2233' },
      { label: 'Password game', value: account.gamePassword || 'N/A', color: '#1a2233' },
      { label: 'Email bind', value: account.gameBindEmail || 'Không có' },
      { label: 'SĐT bind', value: account.gameBindPhone || 'Không có' },
      { label: 'Facebook bind', value: account.gameBindFacebook || 'NONE' },
      { label: 'Người mua', value: user.displayName || user.username || 'N/A' },
      { label: 'Email liên hệ', value: layaway.contactEmail || user.email || 'N/A', color: '#1976d2' },
      { label: 'SĐT liên hệ', value: layaway.contactPhone || 'N/A' },
      { label: 'Hạn thanh toán', value: formatDateVN(layaway.dueDate), color: '#dc2626' },
    ])}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:24px;"><tr><td>&nbsp;</td></tr></table>
    ${ctaButton(adminUrl, 'Vào Admin kiểm tra')}
    ${noticeBox('<b>Cần xử lý:</b> Kiểm tra tình trạng thanh toán và đổi thông tin tài khoản game nếu cần để bảo vệ acc.', 'warn')}
  `

  return sendMail({
    to: adminEmail,
    subject: `[AOV Shop] Đơn trả góp quá hạn ${layaway.layawayCode} - ${account.code || 'N/A'}`,
    html: baseEmail({
      logo,
      title: 'ĐƠN TRẢ GÓP QUÁ HẠN',
      subtitle: 'Một đơn đặt cọc/trả góp cần admin xử lý.',
      badge: 'CẦN XỬ LÝ',
      content,
      footerText: 'Thông báo quản trị từ AOV Shop.',
    }),
    text: `Đơn ${layaway.layawayCode} đã quá hạn. Acc: ${account.code || 'N/A'}. Đã trả ${formatMoney(layaway.paidAmount)}, còn nợ ${formatMoney(layaway.remainingAmount)}.`,
  })
}

const notifyLayawayReminderUser = async ({ layaway, type = 'REMINDER' }) => {
  const email = layaway.contactEmail || layaway.user?.email
  if (!email) return false

  const logo = await getSiteLogo()
  const isOverdue = type === 'OVERDUE'
  const payUrl = `${BRAND_URL}/layaway`

  const content = `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#344054;">
      Xin chào <b>${layaway.user?.displayName || layaway.user?.username || 'bạn'}</b>,
      ${isOverdue
        ? `đơn đặt cọc <b>${layaway.layawayCode}</b> của bạn đã <b style="color:#dc2626;">quá hạn thanh toán</b>. Shop sẽ xử lý theo chính sách nếu đơn không được hoàn tất.`
        : `đơn đặt cọc <b>${layaway.layawayCode}</b> của bạn sắp đến hạn. Vui lòng thanh toán đúng hạn để tránh mất cọc.`
      }
    </p>

    ${heroBlock({
      label: isOverdue ? 'Số tiền còn nợ' : 'Cần thanh toán còn lại',
      value: formatMoney(layaway.remainingAmount),
      sub: `Đã trả ${formatMoney(layaway.paidAmount)} / ${formatMoney(layaway.totalPrice)}`,
      color: isOverdue ? '#dc2626' : '#f59e0b',
    })}

    ${infoCard([
      { label: 'Mã đơn', value: layaway.layawayCode, color: isOverdue ? '#dc2626' : '#f59e0b' },
      { label: 'Tên acc', value: layaway.account?.title || 'N/A' },
      { label: 'Đã trả', value: formatMoney(layaway.paidAmount), color: '#16a34a' },
      { label: 'Còn lại', value: formatMoney(layaway.remainingAmount), color: '#dc2626' },
      { label: 'Hạn thanh toán', value: formatDateVN(layaway.dueDate), color: '#f59e0b' },
    ])}

    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:24px;"><tr><td>&nbsp;</td></tr></table>
    ${ctaButton(payUrl, 'Thanh toán ngay')}
    ${noticeBox(isOverdue
      ? 'Đơn đã quá hạn. Vui lòng liên hệ admin nếu bạn cần hỗ trợ xử lý đơn này.'
      : 'Bạn nên thanh toán trước hạn để giữ tài khoản và tránh mất tiền cọc.', isOverdue ? 'warn' : 'info')}
  `

  return sendMail({
    to: email,
    subject: isOverdue
      ? `[AOV Shop] Đơn đặt cọc ${layaway.layawayCode} đã quá hạn`
      : `[AOV Shop] Nhắc thanh toán đơn đặt cọc ${layaway.layawayCode}`,
    html: baseEmail({
      logo,
      title: isOverdue ? 'ĐƠN ĐẶT CỌC ĐÃ QUÁ HẠN' : 'NHẮC THANH TOÁN ĐẶT CỌC',
      subtitle: isOverdue ? 'Đơn của bạn đã quá hạn thanh toán.' : 'Đơn của bạn sắp đến hạn thanh toán.',
      badge: isOverdue ? 'QUÁ HẠN' : 'NHẮC NHỞ',
      content,
      footerText: 'Cảm ơn bạn đã tin tưởng AOV Shop.',
    }),
    text: isOverdue
      ? `Đơn ${layaway.layawayCode} đã quá hạn. Còn lại ${formatMoney(layaway.remainingAmount)}. Thanh toán tại: ${payUrl}`
      : `Đơn ${layaway.layawayCode} sắp đến hạn. Còn lại ${formatMoney(layaway.remainingAmount)}. Thanh toán tại: ${payUrl}`,
  })
}

module.exports = {
  sendMail,
  notifyLayawayOverdueAdmin,
  notifyLayawayReminderUser,
  notifyAdminTopupOrder,
  notifyUserTopupCompleted,
  sendResetPasswordEmail,
  notifyUserCardPurchase,
  sendVerificationCodeEmail,
}