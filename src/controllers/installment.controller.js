const prisma = require('../config/prisma')

// User gửi yêu cầu tư vấn trả góp
const createRequest = async (req, res) => {
  try {
    const { accountId, phoneNumber, message } = req.body

    const account = await prisma.gameAccount.findUnique({ where: { id: accountId } })
    if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' })

    // Giới hạn 1 request pending per user per account
    const existing = await prisma.installmentRequest.findFirst({
      where: { userId: req.user.id, accountId, status: 'PENDING' }
    })
    if (existing) return res.status(400).json({ success: false, message: 'Bạn đã gửi yêu cầu cho tài khoản này rồi, admin sẽ liên hệ sớm' })

    const request = await prisma.installmentRequest.create({
      data: { userId: req.user.id, accountId, phoneNumber, message, status: 'PENDING' },
      include: { account: { select: { title: true, code: true, price: true } } }
    })

    res.json({ success: true, message: 'Yêu cầu đã được gửi! Admin sẽ liên hệ bạn qua SĐT trong vòng 24h.', data: request })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const getMyRequests = async (req, res) => {
  try {
    const requests = await prisma.installmentRequest.findMany({
      where: { userId: req.user.id },
      include: { account: { select: { title: true, code: true, price: true, thumbnailUrl: true } } },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, data: requests })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// ── ADMIN ──────────────────────────────────────────────────────────────────────

const adminGetRequests = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query
    const where = status ? { status } : {}
    const [total, requests] = await Promise.all([
      prisma.installmentRequest.count({ where }),
      prisma.installmentRequest.findMany({
        where,
        include: {
          user: { select: { username: true, displayName: true, email: true } },
          account: { select: { title: true, code: true, price: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: parseInt(limit)
      })
    ])
    res.json({ success: true, data: { requests, total, page: parseInt(page), totalPages: Math.ceil(total / limit) } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const adminUpdateRequest = async (req, res) => {
  try {
    const { id } = req.params
    const { status, adminNote } = req.body
    const updated = await prisma.installmentRequest.update({
      where: { id },
      data: { status, adminNote, updatedAt: new Date() }
    })
    res.json({ success: true, message: 'Đã cập nhật yêu cầu', data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

module.exports = { createRequest, getMyRequests, adminGetRequests, adminUpdateRequest }
