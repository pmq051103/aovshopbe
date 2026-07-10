const prisma = require('../config/prisma')

// ── Helper: build snapshot from GameAccount ─────────────────
const buildSnapshot = (account) => ({
  title: account.title,
  code: account.code,
  rank: account.rank,
  server: account.server,
  champions: account.champions,
  skins: account.skins,
  level: account.level,
  winRate: account.winRate,
  matches: account.matches,
  gems: account.gems,
  price: account.price,
  thumbnailUrl: account.thumbnailUrl,
  images: account.images?.map(i => ({ url: i.url, sortOrder: i.sortOrder })) || [],
  gameUsername: account.gameUsername,
  gamePassword: account.gamePassword,
  gameBindEmail: account.gameBindEmail,
  gameBindPhone: account.gameBindPhone,
  tags: account.tags,
  isVerified: account.isVerified,
})

// ── Record ownership (called internally after purchase/reward) ─
const recordOwnership = async (tx, { userId, accountId, sourceType, sourceId }) => {
  const account = await tx.gameAccount.findUnique({
    where: { id: accountId },
    include: { images: { orderBy: { sortOrder: 'asc' } } },
  })
  if (!account) return null

  return tx.userOwnedAccount.create({
    data: {
      userId,
      accountId,
      sourceType,
      sourceId: sourceId || null,
      snapshotData: buildSnapshot(account),
    },
  })
}

// ── USER: Get my owned accounts ─────────────────────────────
const getMyOwnedAccounts = async (req, res) => {
  try {
    const { page = 1, limit = 12, source, search } = req.query
    const where = { userId: req.user.id }
    if (source) where.sourceType = source.toUpperCase()

    // Tìm theo mã: filter sau khi lấy nếu có search (vì code nằm trong JSON snapshotData)
    let owned, total

    if (search) {
      // Lấy tất cả của user rồi filter theo code trong snapshotData
      const all = await prisma.userOwnedAccount.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        include: { marketplaceListing: { select: { status: true, price: true } } },
      })
      const searchLower = search.toLowerCase()
      const filtered = all.filter(rec => {
        try {
          const snap = typeof rec.snapshotData === 'string'
            ? JSON.parse(rec.snapshotData)
            : rec.snapshotData
          return (snap.code || '').toLowerCase().includes(searchLower)
        } catch { return false }
      })
      total = filtered.length
      const pageNum = parseInt(page)
      const limitNum = parseInt(limit)
      owned = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum)
    } else {
      ;[owned, total] = await Promise.all([
        prisma.userOwnedAccount.findMany({
          where,
          skip: (parseInt(page) - 1) * parseInt(limit),
          take: parseInt(limit),
          orderBy: { receivedAt: 'desc' },
          include: { marketplaceListing: { select: { status: true, price: true } } },
        }),
        prisma.userOwnedAccount.count({ where }),
      ])
    }

    res.json({
      success: true,
      data: owned,
      pagination: { page: parseInt(page), total, pages: Math.ceil(total / parseInt(limit)) },
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── USER: Get single owned account detail ───────────────────
const getOwnedAccountDetail = async (req, res) => {
  try {
    const record = await prisma.userOwnedAccount.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    })
    if (!record) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    // Try to get current live account too (may have been updated)
    let liveAccount = null
    if (record.accountId) {
      try {
        liveAccount = await prisma.gameAccount.findUnique({
          where: { id: record.accountId },
          select: { id: true, status: true, updatedAt: true },
        })
      } catch (e) {}
    }

    res.json({ success: true, data: { ...record, liveAccount } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN: Gift account to user ─────────────────────────────
const adminGiftAccount = async (req, res) => {
  try {
    const { userId, accountId, note } = req.body
    if (!userId || !accountId) return res.status(400).json({ success: false, message: 'Thiếu userId hoặc accountId' })

    const [user, account] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.gameAccount.findUnique({ where: { id: accountId }, include: { images: { orderBy: { sortOrder: 'asc' } } } }),
    ])
    if (!user) return res.status(404).json({ success: false, message: 'Người dùng không tồn tại' })
    if (!account) return res.status(404).json({ success: false, message: 'Tài khoản không tồn tại' })
    if (account.status !== 'AVAILABLE') return res.status(400).json({ success: false, message: 'Tài khoản không khả dụng' })

    const result = await prisma.$transaction(async tx => {
      await tx.gameAccount.update({
        where: { id: accountId },
        data: { status: 'SOLD', soldAt: new Date(), soldToId: userId },
      })

      const owned = await tx.userOwnedAccount.create({
        data: {
          userId,
          accountId,
          sourceType: 'GIFTED',
          sourceId: `admin:${req.user.id}`,
          snapshotData: buildSnapshot(account),
        },
      })

      await tx.notification.create({
        data: {
          userId,
          type: 'REWARD',
          title: '🎁 Admin đã tặng bạn tài khoản!',
          message: `Bạn nhận được tài khoản ${account.code} — ${account.title}${note ? `: ${note}` : ''}`,
          data: { ownedId: owned.id, accountCode: account.code },
        },
      })

      return owned
    })

    const io = req.app.get('io')
    io?.to(`user:${userId}`).emit('notification', {
      type: 'REWARD',
      title: `🎁 Bạn nhận được tài khoản ${account.code}!`,
    })

    res.json({ success: true, message: `Đã tặng tài khoản ${account.code} cho ${user.username}`, data: result })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN: Get all owned accounts ─────────────────────────────
const adminGetAllOwned = async (req, res) => {
  try {
    const { page = 1, limit = 10, userId, source } = req.query
    const where = {}
    if (userId) where.userId = userId
    if (source) where.sourceType = source.toUpperCase()

    const [records, total] = await Promise.all([
      prisma.userOwnedAccount.findMany({
        where,
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
        orderBy: { receivedAt: 'desc' },
        include: { user: { select: { id: true, username: true, displayName: true, avatar: true } } },
      }),
      prisma.userOwnedAccount.count({ where }),
    ])
    res.json({ success: true, data: records, pagination: { page: parseInt(page), total } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = { recordOwnership, getMyOwnedAccounts, getOwnedAccountDetail, adminGiftAccount, adminGetAllOwned }