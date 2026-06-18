const prisma = require('../config/prisma')
const { sendMail } = require('../config/email')

// ── HELPERS ────────────────────────────────────────────────────────────────────

const formatMoney = (value) => `${parseInt(value || 0).toLocaleString('vi-VN')}đ`

// Lấy email admin từ env hoặc DB settings
const getAdminEmail = async () => {
  try {
    const setting = await prisma.siteConfig.findUnique({ where: { key: 'admin_email' } })
    return setting?.value || process.env.ADMIN_EMAIL || process.env.SMTP_FROM?.match(/<(.+?)>/)?.[1]
  } catch {
    return process.env.ADMIN_EMAIL || null
  }
}

// Gửi email cho admin khi layaway hết hạn
const sendOverdueEmailToAdmin = async (layaway) => {
  const adminEmail = await getAdminEmail()
  if (!adminEmail) return

  const account = layaway.account
  const user = layaway.user

  await sendMail({
    to: adminEmail,
    subject: `[HẾT HẠN TRẢ GÓP] Đơn ${layaway.layawayCode} - ${account?.code}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#111;color:#eee;border-radius:12px;overflow:hidden;">
        <div style="background:#e74c3c;padding:20px;text-align:center;">
          <h2 style="margin:0;color:#fff;">⚠️ Đơn Trả Góp Hết Hạn</h2>
        </div>
        <div style="padding:24px;">
          <p>Đơn đặt cọc <b>${layaway.layawayCode}</b> đã hết hạn thanh toán. Cần xử lý đổi thông tin acc.</p>
          
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;color:#aaa;width:40%;">Mã đơn</td><td style="padding:8px;font-weight:bold;color:#39ff14;">${layaway.layawayCode}</td></tr>
            <tr style="background:#1a1a1a;"><td style="padding:8px;color:#aaa;">Mã acc</td><td style="padding:8px;font-weight:bold;">${account?.code || 'N/A'}</td></tr>
            <tr><td style="padding:8px;color:#aaa;">Tên acc</td><td style="padding:8px;">${account?.title || 'N/A'}</td></tr>
            <tr style="background:#1a1a1a;"><td style="padding:8px;color:#aaa;">Username game</td><td style="padding:8px;font-family:monospace;">${account?.gameUsername || 'N/A'}</td></tr>
            <tr><td style="padding:8px;color:#aaa;">Password game</td><td style="padding:8px;font-family:monospace;">${account?.gamePassword || 'N/A'}</td></tr>
            <tr style="background:#1a1a1a;"><td style="padding:8px;color:#aaa;">Email bind</td><td style="padding:8px;">${account?.gameBindEmail || 'Không có'}</td></tr>
            <tr><td style="padding:8px;color:#aaa;">SĐT bind</td><td style="padding:8px;">${account?.gameBindPhone || 'Không có'}</td></tr>
            <tr style="background:#1a1a1a;"><td style="padding:8px;color:#aaa;">Facebook bind</td><td style="padding:8px;">${account?.gameBindFacebook || 'NONE'}</td></tr>
          </table>

          <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin:16px 0;">
            <h4 style="color:#e74c3c;margin:0 0 8px;">Thông tin người mua</h4>
            <div>Username: <b>${user?.username || 'N/A'}</b></div>
            <div>Email liên hệ: <b>${layaway.contactEmail || user?.email || 'N/A'}</b></div>
            <div>SĐT liên hệ: <b>${layaway.contactPhone || 'N/A'}</b></div>
            <div>Đã trả: <b style="color:#39ff14;">${formatMoney(layaway.paidAmount)} / ${formatMoney(layaway.totalPrice)}</b></div>
            <div>Còn nợ: <b style="color:#e74c3c;">${formatMoney(layaway.remainingAmount)}</b></div>
          </div>

          <p style="color:#e74c3c;font-weight:bold;">→ Vui lòng đổi thông tin tài khoản game ngay để bảo vệ acc.</p>
        </div>
      </div>
    `,
  })
}

// Gửi email nhắc user sắp/đã hết hạn
const sendReminderEmailToUser = async (layaway, type = 'REMINDER') => {
  const email = layaway.contactEmail || layaway.user?.email
  if (!email) return false

  const isOverdue = type === 'OVERDUE'
  const subject = isOverdue
    ? `[ĐÃ QUÁ HẠN] Đơn đặt cọc ${layaway.layawayCode} của bạn`
    : `[NHẮC NHỞ] Đơn đặt cọc ${layaway.layawayCode} sắp đến hạn`

  await sendMail({
    to: email,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#111;color:#eee;border-radius:12px;overflow:hidden;">
        <div style="background:${isOverdue ? '#e74c3c' : '#f39c12'};padding:20px;text-align:center;">
          <h2 style="margin:0;color:#fff;">${isOverdue ? '⚠️ Đơn Đã Quá Hạn' : '🔔 Nhắc Nhở Thanh Toán'}</h2>
        </div>
        <div style="padding:24px;">
          <p>Xin chào <b>${layaway.user?.displayName || layaway.user?.username || 'bạn'}</b>,</p>
          <p>${isOverdue
            ? `Đơn đặt cọc <b>${layaway.layawayCode}</b> của bạn đã <b style="color:#e74c3c;">quá hạn thanh toán</b>. Shop sẽ xử lý đổi thông tin acc theo chính sách.`
            : `Đơn đặt cọc <b>${layaway.layawayCode}</b> của bạn sắp đến hạn. Vui lòng thanh toán đúng hạn để tránh mất cọc.`
          }</p>
          
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;color:#aaa;width:40%;">Mã đơn</td><td style="padding:8px;font-weight:bold;color:#39ff14;">${layaway.layawayCode}</td></tr>
            <tr style="background:#1a1a1a;"><td style="padding:8px;color:#aaa;">Tên acc</td><td style="padding:8px;">${layaway.account?.title || 'N/A'}</td></tr>
            <tr><td style="padding:8px;color:#aaa;">Đã trả</td><td style="padding:8px;color:#39ff14;font-weight:bold;">${formatMoney(layaway.paidAmount)}</td></tr>
            <tr style="background:#1a1a1a;"><td style="padding:8px;color:#aaa;">Còn lại</td><td style="padding:8px;color:#e74c3c;font-weight:bold;">${formatMoney(layaway.remainingAmount)}</td></tr>
            <tr><td style="padding:8px;color:#aaa;">Hạn thanh toán</td><td style="padding:8px;color:#f39c12;font-weight:bold;">${new Date(layaway.dueDate).toLocaleDateString('vi-VN')}</td></tr>
          </table>

          <div style="text-align:center;margin:24px 0;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/user/layaway" 
               style="background:#39ff14;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
              Thanh Toán Ngay
            </a>
          </div>
        </div>
      </div>
    `,
  })
  return true
}

// Hoàn tất layaway - chuyển acc sang SOLD và tạo userOwnedAccount
const completeLayawayAccount = async (tx, layaway) => {
  const account = await tx.gameAccount.findUnique({
    where: { id: layaway.accountId },
  })

  await tx.gameAccount.update({
    where: { id: layaway.accountId },
    data: {
      status: 'SOLD',
      soldToId: layaway.userId,
      soldAt: new Date(),
    },
  })

  await tx.userOwnedAccount.create({
    data: {
      userId: layaway.userId,
      accountId: account.id,
      sourceType: 'PURCHASED',
      sourceId: layaway.id,
      snapshotData: JSON.stringify({
        id: account.id,
        code: account.code,
        title: account.title,
        price: account.price,
        rank: account.rank,
        server: account.server,
        gameUsername: account.gameUsername,
        gamePassword: account.gamePassword,
        gameBindEmail: account.gameBindEmail,
        gameBindPhone: account.gameBindPhone,
        gameBindFacebook: account.gameBindFacebook,
        thumbnailUrl: account.thumbnailUrl,
      }),
    },
  })
}

// ── USER ──────────────────────────────────────────────────────────────────────

// Tạo đặt cọc mới (gộp cọc + trả góp, không còn InstallmentRequest riêng)
const createLayaway = async (req, res) => {
  try {
    const userId = req.user.id
    const { accountId, depositRate = 30, contactEmail, contactPhone } = req.body

    // Validate thông tin liên hệ bắt buộc
    if (!contactEmail || !contactPhone) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập email và số điện thoại liên hệ',
      })
    }

    const account = await prisma.gameAccount.findUnique({ where: { id: accountId } })
    if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' })

    if (account.status !== 'AVAILABLE') {
      return res.status(400).json({
        success: false,
        message: account.status === 'RESERVED'
          ? 'Tài khoản này đang được đặt cọc bởi người khác'
          : 'Tài khoản này đã được bán hoặc không khả dụng',
      })
    }

    // Kiểm tra acc có hỗ trợ trả góp không (phải có installmentDays)
    if (!account.installmentDays || account.installmentDays <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Tài khoản này không hỗ trợ đặt cọc / trả góp',
      })
    }

    const existingLayaway = await prisma.layaway.findUnique({ where: { accountId } })
    if (existingLayaway) {
      return res.status(400).json({ success: false, message: 'Tài khoản này đã có người đặt cọc' })
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })

    const totalPrice = Number(account.price)
    const depositAmount = Math.ceil((totalPrice * Number(depositRate)) / 100)
    const remainingAmount = totalPrice - depositAmount

    if (Number(user.balance) < depositAmount) {
      return res.status(400).json({
        success: false,
        message: `Số dư không đủ. Cần ${depositAmount.toLocaleString('vi-VN')}đ để đặt cọc.`,
      })
    }

    // Tính dueDate dựa theo installmentDays của acc
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + account.installmentDays)

    const code = 'LAY' + Date.now().toString(36).toUpperCase()

    const layaway = await prisma.$transaction(async (tx) => {
      await tx.gameAccount.update({
        where: { id: accountId },
        data: { status: 'RESERVED' },
      })

      await tx.user.update({
        where: { id: userId },
        data: {
          balance: { decrement: depositAmount },
          totalSpent: { increment: depositAmount },
        },
      })

      const created = await tx.layaway.create({
        data: {
          layawayCode: code,
          userId,
          accountId,
          totalPrice,
          depositAmount,
          depositRate: Number(depositRate),
          remainingAmount,
          paidAmount: depositAmount,
          status: depositAmount >= totalPrice ? 'COMPLETED' : 'ACTIVE',
          dueDate,
          completedAt: depositAmount >= totalPrice ? new Date() : null,
          contactEmail,
          contactPhone,
        },
        include: {
          account: {
            select: {
              title: true,
              code: true,
              price: true,
              thumbnailUrl: true,
              installmentDays: true,
              loginRevealPercent: true,
            },
          },
        },
      })

      await tx.layawayPayment.create({
        data: {
          layawayId: created.id,
          amount: depositAmount,
          type: 'DEPOSIT',
          note: 'User thanh toán tiền cọc bằng số dư shop',
        },
      })

      await tx.transaction.create({
        data: {
          userId,
          type: 'PURCHASE',
          status: 'COMPLETED',
          amount: depositAmount,
          balanceBefore: user.balance,
          balanceAfter: Number(user.balance) - depositAmount,
          description: `Đặt cọc acc ${account.code}`,
          referenceId: created.id,
        },
      })

      if (depositAmount >= totalPrice) {
        await completeLayawayAccount(tx, created)
      }

      return created
    }, {
  timeout: 15000,
  maxWait: 10000,
})

    res.json({
      success: true,
      message: 'Đặt cọc thành công.',
      data: layaway,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Thanh toán tiếp bằng số dư
const payLayaway = async (req, res) => {
  try {
    const userId = req.user.id
    const { id } = req.params
    const { amount } = req.body

    const payAmount = Number(amount)
    if (!payAmount || payAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Số tiền thanh toán không hợp lệ' })
    }

    const layaway = await prisma.layaway.findFirst({
      where: { id, userId },
      include: { account: true },
    })

    if (!layaway) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt cọc' })
    }

    if (!['ACTIVE', 'PENDING_DEPOSIT'].includes(layaway.status)) {
      return res.status(400).json({ success: false, message: 'Đơn này không thể thanh toán tiếp' })
    }

    const remaining = Number(layaway.remainingAmount)
    const finalAmount = Math.min(payAmount, remaining)

    const user = await prisma.user.findUnique({ where: { id: userId } })

    if (Number(user.balance) < finalAmount) {
      return res.status(400).json({
        success: false,
        message: `Số dư không đủ. Cần ${finalAmount.toLocaleString('vi-VN')}đ.`,
      })
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          balance: { decrement: finalAmount },
          totalSpent: { increment: finalAmount },
        },
      })

      await tx.layawayPayment.create({
        data: {
          layawayId: id,
          amount: finalAmount,
          type: finalAmount >= remaining ? 'FINAL' : 'INSTALLMENT',
          note: 'User tự thanh toán bằng số dư shop',
        },
      })

      const newPaid = Number(layaway.paidAmount) + finalAmount
      const newRemaining = Math.max(0, Number(layaway.totalPrice) - newPaid)
      const isFullyPaid = newRemaining <= 0

      const updated = await tx.layaway.update({
        where: { id },
        data: {
          paidAmount: newPaid,
          remainingAmount: newRemaining,
          status: isFullyPaid ? 'COMPLETED' : 'ACTIVE',
          completedAt: isFullyPaid ? new Date() : null,
        },
        include: {
          account: true,
          payments: { orderBy: { createdAt: 'asc' } },
        },
      })

      await tx.transaction.create({
        data: {
          userId,
          type: 'PURCHASE',
          status: 'COMPLETED',
          amount: finalAmount,
          balanceBefore: user.balance,
          balanceAfter: Number(user.balance) - finalAmount,
          description: `Thanh toán đặt cọc ${layaway.layawayCode}`,
          referenceId: id,
        },
      })

      if (isFullyPaid) {
        await completeLayawayAccount(tx, updated)
      }

      return updated
    })

    res.json({
      success: true,
      message: result.status === 'COMPLETED'
        ? 'Thanh toán đủ! Acc đã được bàn giao vào Kho Acc.'
        : 'Thanh toán thành công.',
      data: result,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Lấy danh sách layaway của user
const getMyLayaways = async (req, res) => {
  try {
    const layaways = await prisma.layaway.findMany({
      where: { userId: req.user.id },
      include: {
        account: true,
        payments: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    const data = layaways.map((layaway) => {
      const paidPercent =
        (Number(layaway.paidAmount || 0) / Number(layaway.totalPrice || 1)) * 100

      // Dùng loginRevealPercent từ acc, mặc định 100% nếu không có
      const revealThreshold = layaway.account?.loginRevealPercent
        ? Number(layaway.account.loginRevealPercent)
        : 100

      const hasBindInfo =
        !!layaway.account?.gameBindEmail ||
        !!layaway.account?.gameBindPhone

      const isCompleted = layaway.status === 'COMPLETED'

      // Điều kiện xem thông tin: hoàn tất HOẶC đã đạt % theo loginRevealPercent VÀ có bind info
      const canShowLogin =
        isCompleted || (paidPercent >= revealThreshold && hasBindInfo)

      return {
        ...layaway,
        paidPercent,
        canShowLogin,
        revealThreshold, // trả về để frontend hiển thị

        accountHoldMessage:
          !isCompleted &&
          paidPercent >= revealThreshold &&
          !hasBindInfo
            ? 'Acc này hiện không có email hoặc SĐT bind. Vui lòng liên hệ admin để trao đổi nếu muốn cầm acc chơi trước.'
            : null,

        account: {
          ...layaway.account,
          gameUsername: canShowLogin ? layaway.account?.gameUsername : null,
          gamePassword: canShowLogin ? layaway.account?.gamePassword : null,
          gameBindEmail: canShowLogin ? layaway.account?.gameBindEmail : null,
          gameBindPhone: canShowLogin ? layaway.account?.gameBindPhone : null,
          gameBindFacebook: canShowLogin ? layaway.account?.gameBindFacebook : null,
        },
      }
    })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Lấy chi tiết 1 layaway
const getLayawayDetail = async (req, res) => {
  try {
    const layaway = await prisma.layaway.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        account: true,
        payments: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!layaway) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn đặt cọc' })
    res.json({ success: true, data: layaway })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// ── ADMIN ──────────────────────────────────────────────────────────────────────

const adminGetLayaways = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query
    const where = status ? { status } : {}
    const [total, layaways] = await Promise.all([
      prisma.layaway.count({ where }),
      prisma.layaway.findMany({
        where,
        include: {
          user: { select: { username: true, displayName: true, email: true } },
          account: {
            select: {
              title: true,
              code: true,
              price: true,
              thumbnailUrl: true,
              installmentDays: true,
              loginRevealPercent: true,
              gameUsername: true,
              gamePassword: true,
              gameBindEmail: true,
              gameBindPhone: true,
              gameBindFacebook: true,
            },
          },
          payments: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: parseInt(limit),
      }),
    ])
    res.json({
      success: true,
      data: { layaways, total, page: parseInt(page), totalPages: Math.ceil(total / limit) },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Admin ghi nhận thanh toán
const adminRecordPayment = async (req, res) => {
  try {
    const { id } = req.params
    const { amount, type, note } = req.body

    const layaway = await prisma.layaway.findUnique({
      where: { id },
      include: { payments: true, account: true, user: true },
    })
    if (!layaway) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })

    const amountNumber = Number(amount)
    const newPaid = parseFloat(layaway.paidAmount) + amountNumber
    const isFullyPaid = newPaid >= parseFloat(layaway.totalPrice)

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: layaway.userId } })

      if (Number(user.balance) < amountNumber) {
        throw new Error(`Số dư user không đủ. Còn ${Number(user.balance).toLocaleString('vi-VN')}đ.`)
      }

      await tx.user.update({
        where: { id: layaway.userId },
        data: {
          balance: { decrement: amountNumber },
          totalSpent: { increment: amountNumber },
        },
      })

      await tx.layawayPayment.create({
        data: { layawayId: id, amount: amountNumber, type, note },
      })

      const newStatus = isFullyPaid ? 'COMPLETED'
        : type === 'DEPOSIT' ? 'ACTIVE'
        : layaway.status

      const updated = await tx.layaway.update({
        where: { id },
        data: {
          paidAmount: newPaid,
          remainingAmount: Math.max(0, parseFloat(layaway.totalPrice) - newPaid),
          status: newStatus,
          completedAt: isFullyPaid ? new Date() : undefined,
        },
      })

      if (isFullyPaid) {
        await completeLayawayAccount(tx, { ...layaway, ...updated })
      }

      return updated
    })

    res.json({
      success: true,
      message: isFullyPaid ? 'Thanh toán hoàn tất! Acc sẽ được bàn giao.' : 'Đã ghi nhận thanh toán',
      data: result,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Admin huỷ layaway
const adminCancelLayaway = async (req, res) => {
  try {
    const { id } = req.params
    const { cancelReason } = req.body

    const layaway = await prisma.layaway.findUnique({ where: { id } })
    if (!layaway) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })

    await prisma.$transaction(async (tx) => {
      await tx.layaway.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason },
      })
      await tx.gameAccount.update({
        where: { id: layaway.accountId },
        data: { status: 'AVAILABLE' },
      })
    })

    res.json({ success: true, message: 'Đã huỷ đơn đặt cọc' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Admin gửi mail nhắc user
const adminSendReminderToUser = async (req, res) => {
  try {
    const { id } = req.params
    const { type = 'REMINDER' } = req.body // REMINDER | OVERDUE

    const layaway = await prisma.layaway.findUnique({
      where: { id },
      include: {
        user: { select: { username: true, displayName: true, email: true } },
        account: { select: { title: true, code: true } },
      },
    })
    if (!layaway) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })

    const sent = await sendReminderEmailToUser(layaway, type)
    if (!sent) {
      return res.status(400).json({ success: false, message: 'Không có email liên hệ của user' })
    }

    res.json({ success: true, message: 'Đã gửi email nhắc nhở thành công' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Cron job: kiểm tra layaway hết hạn (gọi từ server.js theo schedule)
const checkOverdueLayaways = async () => {
  try {
    const now = new Date()
    const overdueLayaways = await prisma.layaway.findMany({
      where: {
        status: 'ACTIVE',
        dueDate: { lt: now },
      },
      include: {
        user: { select: { username: true, displayName: true, email: true } },
        account: {
          select: {
            code: true, title: true,
            gameUsername: true, gamePassword: true,
            gameBindEmail: true, gameBindPhone: true, gameBindFacebook: true,
          },
        },
      },
    })

    for (const layaway of overdueLayaways) {
      // Cập nhật status OVERDUE
      await prisma.layaway.update({
        where: { id: layaway.id },
        data: { status: 'OVERDUE' },
      })

      // Gửi email cho admin với full thông tin acc
      await sendOverdueEmailToAdmin(layaway)
    }

    if (overdueLayaways.length > 0) {
      console.log(`[Layaway Cron] Đã xử lý ${overdueLayaways.length} đơn hết hạn`)
    }
  } catch (err) {
    console.error('[Layaway Cron] Lỗi:', err.message)
  }
}

module.exports = {
  createLayaway,
  getMyLayaways,
  getLayawayDetail,
  payLayaway,
  adminGetLayaways,
  adminRecordPayment,
  adminCancelLayaway,
  adminSendReminderToUser,
  checkOverdueLayaways,
}
