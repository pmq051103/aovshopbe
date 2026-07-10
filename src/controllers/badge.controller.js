const prisma = require('../config/prisma')

// ── Public ──────────────────────────────────────────────────────────────
const getAllBadges = async (req, res) => {
  try {
    const badges = await prisma.badge.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' }
    })
    res.json({ success: true, data: badges })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const getUserBadges = async (req, res) => {
  try {
    const { userId } = req.params
    const badges = await prisma.userBadge.findMany({
      where: { userId },
      include: { badge: true },
      orderBy: { awardedAt: 'desc' }
    })
    res.json({ success: true, data: badges })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Admin ───────────────────────────────────────────────────────────────
const adminGetBadges = async (req, res) => {
  try {
    const badges = await prisma.badge.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { users: true } } }
    })
    res.json({ success: true, data: badges })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminCreateBadge = async (req, res) => {
  try {
    const { name, description, icon, color, sortOrder } = req.body
    const badge = await prisma.badge.create({
      data: {
        name,
        description,
        icon: icon || null,
        color: color || '#ffffff',
        sortOrder: parseInt(sortOrder || 0),
        imageUrl: req.file?.path || null,
        imagePublicId: req.file?.filename || null
      }
    })
    res.status(201).json({ success: true, data: badge })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminUpdateBadge = async (req, res) => {
  try {
    const data = { ...req.body }
    if (data.sortOrder !== undefined) data.sortOrder = parseInt(data.sortOrder)
    if (data.isActive !== undefined) data.isActive = data.isActive === 'true' || data.isActive === true
    if (req.file?.path) { data.imageUrl = req.file.path; data.imagePublicId = req.file.filename }

    const badge = await prisma.badge.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: badge })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminDeleteBadge = async (req, res) => {
  try {
    await prisma.badge.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa huy hiệu' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Admin tự tay tặng / thu hồi badge cho 1 user (không qua thành tựu tự động)
const adminGrantBadge = async (req, res) => {
  try {
    const { userId, badgeId, note } = req.body
    const userBadge = await prisma.userBadge.upsert({
      where: { userId_badgeId: { userId, badgeId } },
      update: {},
      create: { userId, badgeId, note: note || 'Admin tặng' }
    })
    res.status(201).json({ success: true, data: userBadge })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminRevokeBadge = async (req, res) => {
  try {
    const { userId, badgeId } = req.params
    await prisma.userBadge.delete({ where: { userId_badgeId: { userId, badgeId } } })
    res.json({ success: true, message: 'Đã thu hồi huy hiệu' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = {
  getAllBadges, getUserBadges,
  adminGetBadges, adminCreateBadge, adminUpdateBadge, adminDeleteBadge,
  adminGrantBadge, adminRevokeBadge
}
