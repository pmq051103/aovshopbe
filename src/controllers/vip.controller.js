const prisma = require('../config/prisma')

// Lấy tất cả VIP tiers (public)
const getVipTiers = async (req, res) => {
  try {
    const tiers = await prisma.vipTier.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' }
    })
    res.json({ success: true, data: tiers })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Lấy VIP hiện tại của user
const getMyVip = async (req, res) => {
  try {
    const membership = await prisma.vipMembership.findUnique({
      where: { userId: req.user.id },
      include: { tier: true }
    })

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { totalSpent: true }
    })

    // Tính tier tiếp theo
    const tiers = await prisma.vipTier.findMany({ where: { isActive: true }, orderBy: { minSpent: 'asc' } })
    const currentTotalSpent = parseFloat(user.totalSpent)
    const nextTier = tiers.find(t => parseFloat(t.minSpent) > currentTotalSpent)

    res.json({
      success: true,
      data: {
        membership,
        totalSpent: currentTotalSpent,
        nextTier,
        progressToNext: nextTier
          ? ((currentTotalSpent - (membership ? parseFloat(membership.tier.minSpent) : 0)) /
            (parseFloat(nextTier.minSpent) - (membership ? parseFloat(membership.tier.minSpent) : 0))) * 100
          : 100
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// Helper: tính và cập nhật VIP sau mỗi lần mua hàng (gọi từ order.controller)
const recalculateVip = async (userId) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { totalSpent: true } })
    const totalSpent = parseFloat(user.totalSpent)

    const tiers = await prisma.vipTier.findMany({
      where: { isActive: true },
      orderBy: { minSpent: 'desc' }
    })

    const earnedTier = tiers.find(t => totalSpent >= parseFloat(t.minSpent))
    if (!earnedTier) return

    const existing = await prisma.vipMembership.findUnique({ where: { userId } })
    if (existing?.tierId === earnedTier.id) return

    await prisma.vipMembership.upsert({
      where: { userId },
      create: { userId, tierId: earnedTier.id, totalSpentSnap: totalSpent },
      update: { tierId: earnedTier.id, totalSpentSnap: totalSpent, achievedAt: new Date() }
    })
  } catch (err) {
    console.error('recalculateVip error:', err)
  }
}

// Admin: CRUD VIP tiers
const adminCreateTier = async (req, res) => {
  try {
    const { name, minSpent, discountPercent, bonusQuanHuy, spinBonus, color, icon, sortOrder } = req.body
    const tier = await prisma.vipTier.create({
      data: { name, minSpent: parseFloat(minSpent), discountPercent: parseFloat(discountPercent || 0), bonusQuanHuy: parseInt(bonusQuanHuy || 0), spinBonus: parseInt(spinBonus || 0), color, icon, sortOrder: parseInt(sortOrder || 0) }
    })
    res.json({ success: true, data: tier })
  } catch (err) {
    console.error('adminCreateTier error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminUpdateTier = async (req, res) => {
  try {
    const tier = await prisma.vipTier.update({ where: { id: req.params.id }, data: req.body })
    res.json({ success: true, data: tier })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminDeleteTier = async (req, res) => {
  try {
    await prisma.vipTier.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa tier' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminGetMembers = async (req, res) => {
  try {
    const { tierId, page = 1, limit = 20 } = req.query

    const pageNum = parseInt(page)
    const limitNum = parseInt(limit)

    const where = tierId ? { tierId } : {}

    const [total, members] = await Promise.all([
      prisma.vipMembership.count({ where }),
      prisma.vipMembership.findMany({
        where,
        include: {
          tier: true,
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              email: true,
              totalSpent: true,
            },
          },
        },
        orderBy: {
          achievedAt: 'desc',
        },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ])

    res.json({
      success: true,
      data: {
        members,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
      },
    })
  } catch (err) {
    console.error('adminGetMembers error:', err)
    res.status(500).json({
      success: false,
      message: err.message || 'Lỗi lấy thành viên VIP',
    })
  }
}

module.exports = { getVipTiers, getMyVip, recalculateVip, adminCreateTier, adminUpdateTier, adminDeleteTier, adminGetMembers }
