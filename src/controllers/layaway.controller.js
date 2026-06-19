const prisma = require('../config/prisma')
const { notifyLayawayOverdueAdmin, notifyLayawayReminderUser } = require('../config/email')

// ── HELPERS ────────────────────────────────────────────────────────────────────

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

    // ── Validate % cọc tối thiểu theo từng acc (minDepositPercent, null = mặc định 30%) ──
    const minPercent = account.minDepositPercent != null
      ? Number(account.minDepositPercent)
      : 30

    const requestedRate = Number(depositRate)

    if (!requestedRate || isNaN(requestedRate)) {
      return res.status(400).json({
        success: false,
        message: 'Tỷ lệ đặt cọc không hợp lệ',
      })
    }

    if (requestedRate < minPercent) {
      return res.status(400).json({
        success: false,
        message: `Số tiền cọc tối thiểu là ${minPercent}% giá trị tài khoản`,
      })
    }

    if (requestedRate > 100) {
      return res.status(400).json({
        success: false,
        message: 'Tỷ lệ đặt cọc không được vượt quá 100%',
      })
    }

    const user = await prisma.user.findUnique({ where: { id: userId } })

    const totalPrice = Number(account.price)
    const depositAmount = Math.ceil((totalPrice * requestedRate) / 100)
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
          depositRate: requestedRate,
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
              minDepositPercent: true,
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

    const maskEmail = (email) => {
      if (!email) return null
      const [name, domain] = email.split('@')
      if (!domain) return email
      return `${name.slice(0, 2)}****${name.slice(-1)}@${domain}`
    }

    const maskPhone = (phone) => {
      if (!phone) return null
      return `${phone.slice(0, 1)}******${phone.slice(-3)}`
    }

    const data = layaways.map((layaway) => {
      const paidPercent =
        (Number(layaway.paidAmount || 0) / Number(layaway.totalPrice || 1)) * 100

      const revealThreshold = layaway.account?.loginRevealPercent
        ? Number(layaway.account.loginRevealPercent)
        : 100

      const hasBindInfo =
        !!layaway.account?.gameBindEmail ||
        !!layaway.account?.gameBindPhone

      const isCompleted = layaway.status === 'COMPLETED'

      // Đạt threshold (cọc/trả góp đủ %) → chỉ unlock username/password
      const canShowLogin =
        isCompleted || (paidPercent >= revealThreshold && hasBindInfo)

      // Bind info (email/SĐT/FB) CHỈ hiện khi COMPLETED, và luôn ở dạng mask
      const canShowBindInfo = isCompleted

      return {
        ...layaway,
        paidPercent,
        canShowLogin,
        canShowBindInfo,
        revealThreshold,

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
          // Email/SĐT/FB: chỉ trả về (dạng mask) khi đã COMPLETED, ngược lại null hoàn toàn
          gameBindEmail: canShowBindInfo ? maskEmail(layaway.account?.gameBindEmail) : null,
          gameBindPhone: canShowBindInfo ? maskPhone(layaway.account?.gameBindPhone) : null,
          gameBindFacebook: canShowBindInfo ? layaway.account?.gameBindFacebook : null,
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

    const sent = await notifyLayawayReminderUser({ layaway, type })
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
      await notifyLayawayOverdueAdmin({ layaway })
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
