const prisma = require('../config/prisma')
const { sanitizeRichText } = require('../utils/sanitizeRichText')

/* ─── PUBLIC ──────────────────────────────────────────────── */

// GET /api/announcements/active  → popup hiển thị cho user
const getActive = async (req, res) => {
  try {
    const now = new Date()
    const announcements = await prisma.announcement.findMany({
      where: {
        isActive: true,
        OR: [
          { startAt: null },
          { startAt: { lte: now } },
        ],
        AND: [
          {
            OR: [
              { endAt: null },
              { endAt: { gte: now } },
            ],
          },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, content: true },
    })
    res.json({ success: true, data: announcements })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

/* ─── ADMIN ───────────────────────────────────────────────── */

// GET /api/announcements/admin
const adminGetAll = async (req, res) => {
  try {
    const items = await prisma.announcement.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    })
    res.json({ success: true, data: items })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// POST /api/announcements/admin
const adminCreate = async (req, res) => {
  try {
    const { title, content, isActive = true, sortOrder = 0, startAt, endAt } = req.body
    if (!title || !content) return res.status(400).json({ success: false, message: 'title và content là bắt buộc' })

    const item = await prisma.announcement.create({
      data: {
        title,
        content: sanitizeRichText(content),
        isActive: Boolean(isActive),
        sortOrder: parseInt(sortOrder) || 0,
        startAt: startAt ? new Date(startAt) : null,
        endAt: endAt ? new Date(endAt) : null,
      },
    })
    res.status(201).json({ success: true, data: item })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// PUT /api/announcements/admin/:id
const adminUpdate = async (req, res) => {
  try {
    const { title, content, isActive, sortOrder, startAt, endAt } = req.body
    const data = {}
    if (title !== undefined)     data.title     = title
    if (content !== undefined)   data.content   = sanitizeRichText(content)
    if (isActive !== undefined)  data.isActive  = isActive === true || isActive === 'true'
    if (sortOrder !== undefined) data.sortOrder = parseInt(sortOrder) || 0
    if (startAt !== undefined)   data.startAt   = startAt ? new Date(startAt) : null
    if (endAt !== undefined)     data.endAt     = endAt ? new Date(endAt) : null

    const item = await prisma.announcement.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: item })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// DELETE /api/announcements/admin/:id
const adminDelete = async (req, res) => {
  try {
    await prisma.announcement.delete({ where: { id: req.params.id } })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// PATCH /api/announcements/admin/:id/toggle
const adminToggle = async (req, res) => {
  try {
    const current = await prisma.announcement.findUnique({ where: { id: req.params.id }, select: { isActive: true } })
    if (!current) return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    const item = await prisma.announcement.update({
      where: { id: req.params.id },
      data: { isActive: !current.isActive },
    })
    res.json({ success: true, data: item })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

module.exports = { getActive, adminGetAll, adminCreate, adminUpdate, adminDelete, adminToggle }