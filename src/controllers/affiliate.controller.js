const prisma = require('../config/prisma')
const { emitToAdmins } = require('../config/socket')
const { getAffiliateTierFor } = require('../services/affiliate.service')

// Tạo mã giới thiệu (user gửi yêu cầu làm CTV) — vẫn cần admin duyệt như cũ
const applyAffiliate = async (req, res) => {
  try {
    const userId = req.user.id

    const existing = await prisma.affiliate.findUnique({ where: { userId } })
    if (existing) return res.status(400).json({ success: false, message: 'Bạn đã đăng ký CTV rồi' })

    // Tạo mã ngẫu nhiên CTV_XXXXX
    const code = 'CTV_' + Math.random().toString(36).substring(2, 7).toUpperCase()

    const affiliate = await prisma.affiliate.create({
      data: { userId, code, status: 'PENDING' },
      include: { user: { select: { username: true, displayName: true, email: true } } }
    })

    res.json({ success: true, message: 'Đã gửi yêu cầu đăng ký CTV, chờ admin duyệt', data: affiliate })

    emitToAdmins('admin:new_affiliate', { affiliateId: affiliate.id, code: affiliate.code })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Lấy thông tin affiliate của user hiện tại — kèm bậc hiện tại, bậc kế tiếp, tiến trình từng referral
const getMyAffiliate = async (req, res) => {
  try {
    const affiliate = await prisma.affiliate.findUnique({
      where: { userId: req.user.id },
      include: {
        referrals: {
          include: { referredUser: { select: { username: true, displayName: true, createdAt: true } } },
          orderBy: { createdAt: 'desc' },
          take: 200
        },
        commissions: { orderBy: { createdAt: 'desc' }, take: 200 }
      }
    })
    if (!affiliate) return res.status(404).json({ success: false, message: 'Bạn chưa đăng ký CTV' })

    const tiers = await prisma.affiliateTier.findMany({
      where: { isActive: true },
      orderBy: { minReferrals: 'asc' }
    })

    const currentTier = await getAffiliateTierFor(affiliate.completedReferrals)
    // Bậc kế tiếp = bậc đầu tiên (theo minReferrals tăng dần) mà CTV chưa đạt
    const nextTier = tiers.find(t => t.minReferrals > affiliate.completedReferrals) || null

    const currentMinReferrals = currentTier ? currentTier.minReferrals : 0
    let progressToNext = 100
    if (nextTier) {
      const range = nextTier.minReferrals - currentMinReferrals
      progressToNext = range > 0
        ? ((affiliate.completedReferrals - currentMinReferrals) / range) * 100
        : 100
    }

    res.json({
      success: true,
      data: {
        ...affiliate,
        currentTier,
        nextTier,
        progressToNext
      }
    })
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

// ── ADMIN: Quản lý CTV ────────────────────────────────────────────────────────

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
    console.error('❌ adminGetAffiliates error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminApproveAffiliate = async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body // status: ACTIVE | SUSPENDED
    const affiliate = await prisma.affiliate.update({
      where: { id },
      data: {
        status,
        approvedAt: status === 'ACTIVE' ? new Date() : undefined
      }
    })
    res.json({ success: true, message: `CTV đã được ${status === 'ACTIVE' ? 'duyệt' : 'tạm khóa'}`, data: affiliate })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Gộp lịch sử mua hàng (mua acc / nạp thẻ / mua thẻ cào / túi mù / vòng quay)
// của danh sách userId, dùng cho trang chi tiết CTV (admin xem người được giới thiệu đã mua gì)
const buildPurchaseMap = async (userIds) => {
  if (!userIds || userIds.length === 0) return {}

  const [orders, topups, cards, boxes, spins] = await Promise.all([
    prisma.order.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true, userId: true, orderCode: true, finalAmount: true, status: true, createdAt: true,
        items: { select: { gameAccountTitle: true }, take: 3 }
      },
      orderBy: { createdAt: 'desc' },
      take: 300
    }),
    prisma.gameTopupOrder.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true, userId: true, orderCode: true, status: true, createdAt: true,
        pricePaid: true, quanHuyPaid: true, paymentMethod: true,
        package: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 300
    }),
    prisma.cardPurchase.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true, userId: true, telco: true, denomination: true, totalPrice: true,
        quantity: true, status: true, createdAt: true
      },
      orderBy: { createdAt: 'desc' },
      take: 300
    }),
    prisma.mysteryBoxOpenHistory.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true, userId: true, pricePaid: true, rarity: true, createdAt: true,
        category: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 300
    }),
    prisma.wheelHistory.findMany({
      where: { userId: { in: userIds } },
      select: {
        id: true, userId: true, spinCost: true, rewardName: true, rarity: true, createdAt: true
      },
      orderBy: { createdAt: 'desc' },
      take: 300
    })
  ])

  const map = {}
  const push = (userId, item) => {
    if (!map[userId]) map[userId] = []
    map[userId].push(item)
  }

  orders.forEach(o => push(o.userId, {
    id: o.id,
    type: 'ACCOUNT',
    label: 'Mua tài khoản',
    detail: o.items?.[0]
      ? `${o.items[0].gameAccountTitle}${o.items.length > 1 ? ` +${o.items.length - 1} acc` : ''}`
      : o.orderCode,
    amount: o.finalAmount,
    status: o.status,
    createdAt: o.createdAt
  }))

  topups.forEach(t => push(t.userId, {
    id: t.id,
    type: 'TOPUP',
    label: 'Nạp thẻ game',
    detail: t.package?.name || t.orderCode,
    amount: t.pricePaid || 0,
    status: t.status,
    createdAt: t.createdAt
  }))

  cards.forEach(c => push(c.userId, {
    id: c.id,
    type: 'CARD',
    label: 'Mua thẻ cào',
    detail: `${c.quantity}x ${c.telco} ${Number(c.denomination).toLocaleString('vi-VN')}đ`,
    amount: c.totalPrice,
    status: c.status,
    createdAt: c.createdAt
  }))

  boxes.forEach(b => push(b.userId, {
    id: b.id,
    type: 'BOX',
    label: 'Mở túi mù',
    detail: b.category?.name || b.rarity,
    amount: b.pricePaid,
    status: 'COMPLETED',
    createdAt: b.createdAt
  }))

  spins.forEach(s => push(s.userId, {
    id: s.id,
    type: 'WHEEL',
    label: 'Vòng quay',
    detail: s.rewardName,
    amount: s.spinCost,
    status: 'COMPLETED',
    createdAt: s.createdAt
  }))

  Object.keys(map).forEach(uid => {
    map[uid].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  })
  return map
}

// Admin: xem chi tiết 1 CTV — danh sách người được giới thiệu kèm lịch sử mua hàng của từng người
const adminGetAffiliateDetail = async (req, res) => {
  try {
    const { id } = req.params

    const affiliate = await prisma.affiliate.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true, displayName: true, email: true, createdAt: true } },
        referrals: {
          include: {
            referredUser: { select: { id: true, username: true, displayName: true, email: true, createdAt: true } }
          },
          orderBy: { createdAt: 'desc' }
        },
        commissions: { orderBy: { createdAt: 'desc' } }
      }
    })

    if (!affiliate) return res.status(404).json({ success: false, message: 'Không tìm thấy CTV' })

    const referredUserIds = affiliate.referrals.map(r => r.referredUserId)
    const purchaseMap = await buildPurchaseMap(referredUserIds)

    const referrals = affiliate.referrals.map(r => {
      const purchases = purchaseMap[r.referredUserId] || []
      const totalPurchased = purchases.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0)
      return { ...r, purchases, purchaseCount: purchases.length, totalPurchased }
    })

    res.json({ success: true, data: { ...affiliate, referrals } })
  } catch (err) {
    console.error('❌ adminGetAffiliateDetail error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

// ── ADMIN: Quản lý bậc hoa hồng (AffiliateTier) ──────────────────────────────

const getAffiliateTiers = async (req, res) => {
  try {
    const tiers = await prisma.affiliateTier.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' }
    })
    res.json({ success: true, data: tiers })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminGetAllTiers = async (req, res) => {
  try {
    const tiers = await prisma.affiliateTier.findMany({ orderBy: { sortOrder: 'asc' } })
    res.json({ success: true, data: tiers })
  } catch (err) {
    console.error('❌ adminGetAllTiers error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminCreateTier = async (req, res) => {
  try {
    const { name, minReferrals, commissionPercent, color, icon, sortOrder } = req.body
    const tier = await prisma.affiliateTier.create({
      data: {
        name,
        minReferrals: parseInt(minReferrals),
        commissionPercent: parseFloat(commissionPercent || 0),
        color,
        icon,
        sortOrder: parseInt(sortOrder || 0)
      }
    })
    res.json({ success: true, data: tier })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminUpdateTier = async (req, res) => {
  try {
    const data = { ...req.body }
    if (data.minReferrals !== undefined) data.minReferrals = parseInt(data.minReferrals)
    if (data.commissionPercent !== undefined) data.commissionPercent = parseFloat(data.commissionPercent)
    if (data.sortOrder !== undefined) data.sortOrder = parseInt(data.sortOrder)

    const tier = await prisma.affiliateTier.update({
      where: { id: req.params.id },
      data
    })
    res.json({ success: true, data: tier })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminDeleteTier = async (req, res) => {
  try {
    await prisma.affiliateTier.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa bậc CTV' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

module.exports = {
  applyAffiliate, getMyAffiliate, validateAffiliateCode,
  adminGetAffiliates, adminApproveAffiliate, adminGetAffiliateDetail,
  getAffiliateTiers, adminGetAllTiers, adminCreateTier, adminUpdateTier, adminDeleteTier
}