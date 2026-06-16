const prisma = require('../config/prisma')

// ── WISHLIST ──────────────────────────────────────────────────────────────────

const getWishlist = async (req, res) => {
  try {
    const items = await prisma.wishlist.findMany({
      where: { userId: req.user.id },
      include: {
        account: {
          include: {
            images: { take: 1, orderBy: { sortOrder: 'asc' } },
            categoryRelations: { include: { category: true }, take: 1 }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, data: items })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const toggleWishlist = async (req, res) => {
  try {
    const { accountId } = req.body
    const userId = req.user.id

    const existing = await prisma.wishlist.findUnique({ where: { userId_accountId: { userId, accountId } } })
    if (existing) {
      await prisma.wishlist.delete({ where: { userId_accountId: { userId, accountId } } })
      return res.json({ success: true, added: false, message: 'Đã xóa khỏi danh sách yêu thích' })
    }

    await prisma.wishlist.create({ data: { userId, accountId } })
    res.json({ success: true, added: true, message: 'Đã thêm vào danh sách yêu thích' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

const checkWishlist = async (req, res) => {
  try {
    const { accountId } = req.params
    const item = await prisma.wishlist.findUnique({
      where: { userId_accountId: { userId: req.user.id, accountId } }
    })
    res.json({ success: true, inWishlist: !!item })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// ── SO SÁNH (batch fetch) ─────────────────────────────────────────────────────

const compareAccounts = async (req, res) => {
  try {
    const { ids } = req.body // array of account IDs, max 3
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 3)
      return res.status(400).json({ success: false, message: 'Chọn 2-3 tài khoản để so sánh' })

    const accounts = await prisma.gameAccount.findMany({
      where: { id: { in: ids } },
      include: {
        images: { take: 1, orderBy: { sortOrder: 'asc' } },
        categoryRelations: { include: { category: true }, take: 1 },
        skins_rel: { orderBy: { skinName: 'asc' } }
      }
    })
    res.json({ success: true, data: accounts })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

module.exports = { getWishlist, toggleWishlist, checkWishlist, compareAccounts }
