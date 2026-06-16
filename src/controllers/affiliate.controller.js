const prisma = require('../config/prisma')

// Tạo mã giới thiệu (user đăng ký làm CTV)
const applyAffiliate = async (req, res) => {
  try {
    const userId = req.user.id
    const { bankName, bankAccount, bankOwner, note } = req.body

    const existing = await prisma.affiliate.findUnique({ where: { userId } })
    if (existing) return res.status(400).json({ success: false, message: 'Bạn đã đăng ký CTV rồi' })

    // Tạo mã ngẫu nhiên CTV_XXXXX
    const code = 'CTV_' + Math.random().toString(36).substring(2, 7).toUpperCase()

    const affiliate = await prisma.affiliate.create({
      data: { userId, code, bankName, bankAccount, bankOwner, note, status: 'PENDING' },
      include: { user: { select: { username: true, displayName: true, email: true } } }
    })

    res.json({ success: true, message: 'Đăng ký CTV thành công, chờ admin duyệt', data: affiliate })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Lấy thông tin affiliate của user hiện tại
const getMyAffiliate = async (req, res) => {
  try {
    const affiliate = await prisma.affiliate.findUnique({
      where: { userId: req.user.id },
      include: {
        referrals: {
          include: { referredUser: { select: { username: true, displayName: true, createdAt: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20
        },
        commissions: { orderBy: { createdAt: 'desc' }, take: 30 },
        withdrawals: { orderBy: { createdAt: 'desc' }, take: 10 }
      }
    })
    if (!affiliate) return res.status(404).json({ success: false, message: 'Bạn chưa đăng ký CTV' })
    res.json({ success: true, data: affiliate })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// User yêu cầu rút hoa hồng
const requestWithdrawal = async (req, res) => {
  try {
    const { amount } = req.body
    const affiliate = await prisma.affiliate.findUnique({ where: { userId: req.user.id } })
    if (!affiliate || affiliate.status !== 'ACTIVE')
      return res.status(400).json({ success: false, message: 'Tài khoản CTV chưa được kích hoạt' })

    if (parseFloat(amount) > parseFloat(affiliate.pendingBalance))
      return res.status(400).json({ success: false, message: 'Số dư hoa hồng không đủ' })

    if (parseFloat(amount) < 50000)
      return res.status(400).json({ success: false, message: 'Rút tối thiểu 50,000đ' })

    const withdrawal = await prisma.affiliateWithdrawal.create({
      data: { affiliateId: affiliate.id, amount: parseFloat(amount), status: 'PENDING' }
    })

    res.json({ success: true, message: 'Yêu cầu rút tiền đã được gửi', data: withdrawal })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Validate mã giới thiệu (dùng khi đăng ký)
const validateAffiliateCode = async (req, res) => {
  try {
    const { code } = req.params
    const affiliate = await prisma.affiliate.findUnique({
      where: { code },
      include: { user: { select: { displayName: true, username: true } } }
    })
    if (!affiliate || affiliate.status !== 'ACTIVE')
      return res.status(404).json({ success: false, message: 'Mã giới thiệu không hợp lệ' })

    res.json({ success: true, data: { code: affiliate.code, owner: affiliate.user.displayName || affiliate.user.username } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────

const adminGetAffiliates = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query
    const where = status ? { status } : {}
    const [total, affiliates] = await Promise.all([
      prisma.affiliate.count({ where }),
      prisma.affiliate.findMany({
        where,
        include: { user: { select: { username: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: parseInt(limit)
      })
    ])
    res.json({ success: true, data: { affiliates, total, page: parseInt(page), totalPages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminApproveAffiliate = async (req, res) => {
  try {
    const { id } = req.params
    const { status, commissionRate } = req.body // status: ACTIVE | SUSPENDED
    const affiliate = await prisma.affiliate.update({
      where: { id },
      data: {
        status,
        commissionRate: commissionRate ? parseFloat(commissionRate) : undefined,
        approvedAt: status === 'ACTIVE' ? new Date() : undefined
      }
    })
    res.json({ success: true, message: `CTV đã được ${status === 'ACTIVE' ? 'duyệt' : 'tạm khóa'}`, data: affiliate })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminProcessWithdrawal = async (req, res) => {
  try {
    const { id } = req.params
    const { status, note } = req.body // APPROVED | REJECTED | PAID
    const withdrawal = await prisma.affiliateWithdrawal.findUnique({ where: { id }, include: { affiliate: true } })
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Không tìm thấy yêu cầu' })

    await prisma.$transaction(async (tx) => {
      await tx.affiliateWithdrawal.update({
        where: { id },
        data: { status, note, processedAt: new Date() }
      })
      // Nếu duyệt thanh toán → trừ pendingBalance, cộng totalPaid
      if (status === 'PAID') {
        await tx.affiliate.update({
          where: { id: withdrawal.affiliateId },
          data: {
            pendingBalance: { decrement: withdrawal.amount },
            totalPaid: { increment: withdrawal.amount }
          }
        })
      }
      // Nếu từ chối → hoàn lại pendingBalance
      if (status === 'REJECTED') {
        await tx.affiliate.update({
          where: { id: withdrawal.affiliateId },
          data: { pendingBalance: { increment: withdrawal.amount } }
        })
      }
    })

    res.json({ success: true, message: 'Đã xử lý yêu cầu rút tiền' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Helper: ghi nhận hoa hồng khi có đơn hàng thành công (gọi từ order.controller)
const recordCommission = async (orderId, buyerUserId, orderAmount) => {
  try {
    // Tìm affiliate của người giới thiệu buyer
    const referral = await prisma.affiliateReferral.findUnique({
      where: { referredUserId: buyerUserId },
      include: { affiliate: true }
    })
    if (!referral || referral.affiliate.status !== 'ACTIVE') return

    const rate = parseFloat(referral.affiliate.commissionRate)
    const commission = (orderAmount * rate) / 100

    await prisma.$transaction([
      prisma.affiliateCommission.create({
        data: {
          affiliateId: referral.affiliateId,
          orderId,
          amount: commission,
          rate,
          orderAmount,
          status: 'PENDING'
        }
      }),
      prisma.affiliate.update({
        where: { id: referral.affiliateId },
        data: {
          totalEarned: { increment: commission },
          pendingBalance: { increment: commission }
        }
      })
    ])
  } catch (err) {
    console.error('recordCommission error:', err)
  }
}

module.exports = {
  applyAffiliate, getMyAffiliate, requestWithdrawal, validateAffiliateCode,
  adminGetAffiliates, adminApproveAffiliate, adminProcessWithdrawal, recordCommission
}
