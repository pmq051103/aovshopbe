const prisma = require('../config/prisma')

// ── USER ──────────────────────────────────────────────────────────────────────

// Tạo đặt cọc mới
const createLayaway = async (req, res) => {
  try {
    const userId = req.user.id
    const { accountId, depositRate = 30 } = req.body

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

    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + 7)

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
        },
        include: {
          account: {
            select: {
              title: true,
              code: true,
              price: true,
              thumbnailUrl: true,
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

// Thanh toán 
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

// Trả cọc lần cuối 
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
        (Number(layaway.paidAmount || 0) /
          Number(layaway.totalPrice || 1)) *
        100

      const hasBindInfo =
        !!layaway.account?.gameBindEmail ||
        !!layaway.account?.gameBindPhone

      const isCompleted = layaway.status === 'COMPLETED'

      // Đã hoàn tất => luôn xem được
      // Chưa hoàn tất => phải >=70% và acc có email/sđt bind
      const canShowLogin =
        isCompleted || (paidPercent >= 70 && hasBindInfo)

      return {
        ...layaway,

        paidPercent,
        canShowLogin,

        accountHoldMessage:
          !isCompleted &&
          paidPercent >= 70 &&
          !hasBindInfo
            ? 'Acc này hiện không có email hoặc SĐT bind. Bạn đã thanh toán từ 70%, vui lòng liên hệ admin để trao đổi nếu muốn cầm acc chơi trước.'
            : null,

        account: {
          ...layaway.account,

          gameUsername: canShowLogin
            ? layaway.account?.gameUsername
            : null,

          gamePassword: canShowLogin
            ? layaway.account?.gamePassword
            : null,

          // Thông tin bind vẫn cho xem khi đã đủ điều kiện
          gameBindEmail: canShowLogin
            ? layaway.account?.gameBindEmail
            : null,

          gameBindPhone: canShowLogin
            ? layaway.account?.gameBindPhone
            : null,

          gameBindFacebook: canShowLogin
            ? layaway.account?.gameBindFacebook
            : null,
        },
      }
    })

    res.json({
      success: true,
      data,
    })
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    })
  }
}

// Lấy chi tiết 1 layaway
const getLayawayDetail = async (req, res) => {
  try {
    const layaway = await prisma.layaway.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        account: true,
        payments: { orderBy: { createdAt: 'asc' } }
      }
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
          account: { select: { title: true, code: true, price: true, thumbnailUrl: true } },
          payments: true
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: parseInt(limit)
      })
    ])
    res.json({ success: true, data: { layaways, total, page: parseInt(page), totalPages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Admin ghi nhận thanh toán cọc / trả góp / trả hết
const adminRecordPayment = async (req, res) => {
  try {
    const { id } = req.params
    const { amount, type, note } = req.body // type: DEPOSIT | INSTALLMENT | FINAL

    const layaway = await prisma.layaway.findUnique({ where: { id }, include: { payments: true } })
    if (!layaway) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })

    const newPaid = parseFloat(layaway.paidAmount) + parseFloat(amount)
    const isFullyPaid = newPaid >= parseFloat(layaway.totalPrice)

    const result = await prisma.$transaction(async (tx) => {
      const amountNumber = Number(amount)

      const user = await prisma.user.findUnique({
        where: { id: layaway.userId },
      })

      if (Number(user.balance) < amountNumber) {
        return res.status(400).json({
          success: false,
          message: `Số dư user không đủ. Còn ${Number(user.balance).toLocaleString('vi-VN')}đ.`,
        })
      }

      await tx.user.update({
        where: { id: layaway.userId },
        data: {
          balance: { decrement: amountNumber },
          totalSpent: { increment: amountNumber },
        },
      })
      await tx.layawayPayment.create({
        data: { layawayId: id, amount: parseFloat(amount), type, note }
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
          completedAt: isFullyPaid ? new Date() : undefined
        }
      })

      // Nếu đã thanh toán hết → chuyển acc sang SOLD
      if (isFullyPaid) {
        await tx.gameAccount.update({ where: { id: layaway.accountId }, data: { status: 'SOLD' } })
      }

      return updated
    })

    res.json({ success: true, message: isFullyPaid ? 'Thanh toán hoàn tất! Acc sẽ được bàn giao.' : 'Đã ghi nhận thanh toán', data: result })
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
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason }
      })
      // Trả acc về AVAILABLE
      await tx.gameAccount.update({ where: { id: layaway.accountId }, data: { status: 'AVAILABLE' } })
    })

    res.json({ success: true, message: 'Đã huỷ đơn đặt cọc' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
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
}