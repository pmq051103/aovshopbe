const prisma = require('../config/prisma')

// Public: recent activity feed (ẩn username một phần)
const getRecentActivity = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 20), 50)

    // Lấy đơn mua acc gần đây
    const orders = await prisma.order.findMany({
      where: { status: 'COMPLETED' },
      take: limit,
      orderBy: { completedAt: 'desc' },
      include: {
        user: { select: { username: true, displayName: true } },
        items: { take: 1, select: { accountName: true, price: true } },
      },
    })

    // Lấy kết quả vòng quay gần đây
    const wheelWins = await prisma.wheelSpin.findMany({
      where: { reward: { isNot: null } },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { username: true, displayName: true } },
        reward: { select: { name: true, type: true } },
      },
    })

    // Lấy mystery box gần đây
    let boxOpens = []
    try {
      boxOpens = await prisma.mysteryBoxOrder.findMany({
        where: { status: 'COMPLETED' },
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { username: true, displayName: true } },
          box: { select: { name: true } },
        },
      })
    } catch (_) {}

    const maskName = (user) => {
      const name = user?.displayName || user?.username || 'Ẩn danh'
      if (name.length <= 3) return name + '***'
      return name.substring(0, Math.ceil(name.length / 2)) + '***'
    }

    const activities = []

    for (const o of orders) {
      const itemName = o.items[0]?.accountName || 'Tài khoản'
      activities.push({
        id: `order-${o.id}`,
        type: 'BUY_ACC',
        username: maskName(o.user),
        label: `vừa mua ${itemName}`,
        time: o.completedAt || o.createdAt,
      })
    }

    for (const w of wheelWins) {
      if (!w.reward) continue
      activities.push({
        id: `wheel-${w.id}`,
        type: 'LUCKY_WHEEL',
        username: maskName(w.user),
        label: `vừa quay trúng ${w.reward.name}`,
        time: w.createdAt,
      })
    }

    for (const b of boxOpens) {
      activities.push({
        id: `box-${b.id}`,
        type: 'MYSTERY_BOX',
        username: maskName(b.user),
        label: `vừa mở túi mù ${b.box?.name || ''}`,
        time: b.createdAt,
      })
    }

    // Sort by time desc and return mixed
    activities.sort((a, b) => new Date(b.time) - new Date(a.time))

    res.json({ success: true, data: activities.slice(0, limit) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Generate order code
const genOrderCode = () => {
  const now = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `ORD-${now}-${rand}`
}

// User: get my orders
const getMyOrders = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query
    const where = { userId: req.user.id }
    if (status) where.status = status

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, skip: (page - 1) * parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { items: true, coupon: { select: { code: true, name: true } } }
      }),
      prisma.order.count({ where })
    ])
    res.json({ success: true, data: orders, pagination: { page: parseInt(page), total, pages: Math.ceil(total / limit) } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// User: get single order
const getOrderById = async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { items: true, coupon: true }
    })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng' })
    res.json({ success: true, data: order })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// User: request refund / dispute
const requestRefund = async (req, res) => {
  try {
    const { reason } = req.body
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.user.id, status: 'COMPLETED' }
    })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy hoặc không thể hoàn tiền' })

    const hoursSince = (Date.now() - new Date(order.completedAt).getTime()) / 3600000
    if (hoursSince > 24) return res.status(400).json({ success: false, message: 'Đã quá 24h, không thể yêu cầu hoàn tiền' })

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'DISPUTED', refundReason: reason }
    })
    res.json({ success: true, message: 'Yêu cầu hoàn tiền đã được gửi, admin sẽ xử lý trong 24h' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ─── ADMIN ───────────────────────────────────

const adminGetOrders = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search, userId } = req.query
    const where = {}
    if (status) where.status = status
    if (userId) where.userId = userId
    if (search) where.orderCode = { contains: search }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where, skip: (page - 1) * parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
  user: {
    select: {
      id: true,
      username: true,
      displayName: true,
      avatar: true
    }
  },

  items: {
    select: {
      id: true,
      gameAccountId: true,
      gameAccountCode: true,
      gameAccountTitle: true,
      gameAccountRank: true,
      gameAccountServer: true,
      price: true,

      gameUsername: true,
      gamePassword: true,

      gameBindEmail: true,
      gameBindPhone: true,
      gameBindFacebook: true,
    }
  },

  coupon: {
    select: {
      code: true
    }
  }
}
      }),
      prisma.order.count({ where })
    ])
    res.json({ success: true, data: orders, pagination: { page: parseInt(page), total, pages: Math.ceil(total / limit) } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminRefundOrder = async (req, res) => {
  try {
    const { reason } = req.body
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { user: true, items: true }
    })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    if (!['COMPLETED', 'DISPUTED'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Không thể hoàn tiền đơn hàng này' })
    }

    await prisma.$transaction(async tx => {
      const updatedUser = await tx.user.update({
        where: { id: order.userId },
        data: { balance: { increment: order.finalAmount } }
      })
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'REFUNDED', refundReason: reason, refundedAt: new Date() }
      })
      await tx.transaction.create({
        data: {
          userId: order.userId, type: 'REFUND', status: 'COMPLETED',
          amount: order.finalAmount,
          balanceBefore: updatedUser.balance - order.finalAmount,
          balanceAfter: updatedUser.balance,
          description: `Hoàn tiền đơn #${order.orderCode}: ${reason || 'Admin hoàn tiền'}`,
          referenceId: order.id
        }
      })
      // Re-set accounts to AVAILABLE if possible
      for (const item of order.items) {
        await tx.gameAccount.updateMany({
          where: { id: item.gameAccountId, status: 'SOLD' },
          data: { status: 'AVAILABLE', soldAt: null, soldToId: null }
        })
      }
      await tx.notification.create({
        data: {
          userId: order.userId, type: 'PURCHASE',
          title: '↩️ Hoàn tiền thành công',
          message: `Đơn hàng #${order.orderCode} đã được hoàn tiền ${parseInt(order.finalAmount).toLocaleString('vi-VN')}đ`,
          data: { orderId: order.id }
        }
      })
    })

    const io = req.app.get('io')
    io?.to(`user:${order.userId}`).emit('deposit:success', { amount: order.finalAmount, message: 'Hoàn tiền thành công!' })

    res.json({ success: true, message: 'Hoàn tiền thành công' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminGetOrderStats = async (req, res) => {
  try {
    const now = new Date()
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [total, month, disputed, refunded, topAccounts] = await Promise.all([
      prisma.order.count({ where: { status: 'COMPLETED' } }),
      prisma.order.aggregate({ where: { status: 'COMPLETED', createdAt: { gte: startMonth } }, _sum: { finalAmount: true }, _count: true }),
      prisma.order.count({ where: { status: 'DISPUTED' } }),
      prisma.order.count({ where: { status: 'REFUNDED' } }),
      prisma.orderItem.groupBy({
        by: ['gameAccountCode', 'gameAccountTitle'],
        _count: true, _sum: { price: true },
        orderBy: { _count: { gameAccountCode: 'desc' } },
        take: 5
      })
    ])

    res.json({
      success: true,
      data: {
        totalCompleted: total,
        monthCount: month._count,
        monthRevenue: month._sum.finalAmount || 0,
        disputed, refunded, topAccounts
      }
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = { getMyOrders, getOrderById, requestRefund, adminGetOrders, adminRefundOrder, adminGetOrderStats, getRecentActivity }