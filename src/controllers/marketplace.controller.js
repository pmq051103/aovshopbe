const prisma = require('../config/prisma')
const { emitToUser, emitToAdmins } = require('../config/socket')
const { checkAndGrantAchievements } = require('./achievement.controller')

const DEFAULT_FEE_PERCENT = 10

const getFeePercent = async () => {
  try {
    const cfg = await prisma.siteConfig.findUnique({ where: { key: 'marketplace_fee_percent' } })
    const val = parseFloat(cfg?.value)
    return Number.isFinite(val) && val > 0 ? val : DEFAULT_FEE_PERCENT
  } catch { return DEFAULT_FEE_PERCENT }
}

const parseSnapshot = (rec) => {
  try {
    return typeof rec.snapshotData === 'string' ? JSON.parse(rec.snapshotData) : rec.snapshotData
  } catch { return {} }
}

const withSnapshot = (listing) => ({
  ...listing,
  snapshot: listing.ownedAccount ? parseSnapshot(listing.ownedAccount) : null,
})

// ── Public: duyệt chợ ──────────────────────────────────────────────────
const getListings = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, minPrice, maxPrice, sort = 'newest' } = req.query
    const where = { status: 'APPROVED' }
    if (minPrice) where.price = { ...where.price, gte: parseFloat(minPrice) }
    if (maxPrice) where.price = { ...where.price, lte: parseFloat(maxPrice) }
    if (search) where.title = { contains: search }

    const orderBy =
      sort === 'price_asc' ? { price: 'asc' } :
      sort === 'price_desc' ? { price: 'desc' } :
      { approvedAt: 'desc' }

    const [listings, total] = await Promise.all([
      prisma.marketplaceListing.findMany({
        where,
        include: {
          seller: { select: { id: true, username: true, displayName: true, avatar: true } },
          ownedAccount: true,
        },
        orderBy,
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.marketplaceListing.count({ where }),
    ])

    res.json({
      success: true,
      data: listings.map(withSnapshot),
      pagination: { page: parseInt(page), total, pages: Math.ceil(total / parseInt(limit)) },
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const getListingDetail = async (req, res) => {
  try {
    const listing = await prisma.marketplaceListing.findUnique({
      where: { id: req.params.id },
      include: {
        seller: { select: { id: true, username: true, displayName: true, avatar: true, createdAt: true } },
        buyer: { select: { id: true, username: true, displayName: true } },
        ownedAccount: true,
      },
    })
    if (!listing) return res.status(404).json({ success: false, message: 'Không tìm thấy tin đăng' })
    res.json({ success: true, data: withSnapshot(listing) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── User ──────────────────────────────────────────────────────────────
// Danh sách acc đang sở hữu mà CHƯA đem bán (để chọn khi đăng tin)
const getMySellableAccounts = async (req, res) => {
  try {
    const accounts = await prisma.userOwnedAccount.findMany({
      where: { userId: req.user.id, marketplaceListing: null },
      orderBy: { receivedAt: 'desc' },
    })
    res.json({ success: true, data: accounts })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const getMyListings = async (req, res) => {
  try {
    const listings = await prisma.marketplaceListing.findMany({
      where: { sellerId: req.user.id },
      include: { ownedAccount: true, buyer: { select: { username: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: listings.map(withSnapshot) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const getMyPurchases = async (req, res) => {
  try {
    const listings = await prisma.marketplaceListing.findMany({
      where: { buyerId: req.user.id, status: 'SOLD' },
      include: { ownedAccount: true, seller: { select: { username: true, displayName: true } } },
      orderBy: { soldAt: 'desc' },
    })
    res.json({ success: true, data: listings.map(withSnapshot) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const createListing = async (req, res) => {
  try {
    const { ownedAccountId, title, description, price } = req.body
    const priceNum = parseFloat(price)
    if (!priceNum || priceNum <= 0) return res.status(400).json({ success: false, message: 'Giá bán không hợp lệ' })

    const owned = await prisma.userOwnedAccount.findFirst({
      where: { id: ownedAccountId, userId: req.user.id },
      include: { marketplaceListing: true },
    })
    if (!owned) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản để bán' })
    if (owned.marketplaceListing) return res.status(400).json({ success: false, message: 'Tài khoản này đã được đăng bán rồi' })

    const feePercent = await getFeePercent()

    const listing = await prisma.marketplaceListing.create({
      data: {
        sellerId: req.user.id,
        ownedAccountId,
        title: title || parseSnapshot(owned).title || 'Tài khoản game',
        description,
        price: priceNum,
        feePercent,
      },
    })

    emitToAdmins('marketplace:new_listing', { id: listing.id, title: listing.title, price: priceNum })
    res.status(201).json({ success: true, data: listing, message: 'Đã gửi tin đăng, chờ admin duyệt' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const cancelListing = async (req, res) => {
  try {
    const listing = await prisma.marketplaceListing.findFirst({ where: { id: req.params.id, sellerId: req.user.id } })
    if (!listing) return res.status(404).json({ success: false, message: 'Không tìm thấy tin đăng' })
    if (!['PENDING', 'APPROVED'].includes(listing.status)) {
      return res.status(400).json({ success: false, message: 'Không thể huỷ tin đăng ở trạng thái này' })
    }
    await prisma.marketplaceListing.update({ where: { id: listing.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } })
    res.json({ success: true, message: 'Đã huỷ tin đăng' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Mua acc (P2P) ────────────────────────────────────────────────────
const buyListing = async (req, res) => {
  try {
    const buyerId = req.user.id
    const { id } = req.params

    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findUnique({ where: { id }, include: { ownedAccount: true } })
      if (!listing) throw Object.assign(new Error('Không tìm thấy tin đăng'), { code: 404 })
      if (listing.status !== 'APPROVED') throw Object.assign(new Error('Tin đăng không còn khả dụng'), { code: 400 })
      if (listing.sellerId === buyerId) throw Object.assign(new Error('Bạn không thể mua tài khoản của chính mình'), { code: 400 })

      const buyer = await tx.user.findUnique({ where: { id: buyerId } })
      const price = parseFloat(listing.price)
      if (parseFloat(buyer.balance) < price) throw Object.assign(new Error('Số dư không đủ'), { code: 400 })

      const feeAmount = Math.round(price * (parseFloat(listing.feePercent) / 100))
      const sellerReceive = price - feeAmount

      const updatedBuyer = await tx.user.update({
        where: { id: buyerId },
        data: { balance: { decrement: price }, totalSpent: { increment: price } },
      })
      const updatedSeller = await tx.user.update({
        where: { id: listing.sellerId },
        data: { balance: { increment: sellerReceive } },
      })

      await tx.transaction.createMany({
        data: [
          {
            userId: buyerId, type: 'MARKETPLACE_PURCHASE', amount: -price,
            balanceBefore: parseFloat(updatedBuyer.balance) + price, balanceAfter: parseFloat(updatedBuyer.balance),
            description: `Mua "${listing.title}" trên chợ trao đổi`, referenceId: listing.id,
          },
          {
            userId: listing.sellerId, type: 'MARKETPLACE_SALE', amount: sellerReceive,
            balanceBefore: parseFloat(updatedSeller.balance) - sellerReceive, balanceAfter: parseFloat(updatedSeller.balance),
            description: `Bán "${listing.title}" trên chợ trao đổi (đã trừ phí ${listing.feePercent}%: ${feeAmount.toLocaleString('vi-VN')}đ)`,
            referenceId: listing.id,
          },
        ],
      })

      const newOwned = await tx.userOwnedAccount.create({
        data: {
          userId: buyerId,
          accountId: listing.ownedAccount.accountId,
          sourceType: 'MARKETPLACE_PURCHASE',
          sourceId: listing.id,
          snapshotData: listing.ownedAccount.snapshotData,
        },
      })

      const updatedListing = await tx.marketplaceListing.update({
        where: { id },
        data: { status: 'SOLD', buyerId, soldAt: new Date() },
      })

      await tx.notification.createMany({
        data: [
          {
            userId: listing.sellerId, type: 'MARKETPLACE', title: 'Đã bán thành công!',
            message: `"${listing.title}" đã được mua với giá ${price.toLocaleString('vi-VN')}đ. Bạn nhận ${sellerReceive.toLocaleString('vi-VN')}đ sau phí sàn.`,
          },
          {
            userId: buyerId, type: 'MARKETPLACE', title: 'Mua tài khoản thành công!',
            message: `Bạn đã mua "${listing.title}" với giá ${price.toLocaleString('vi-VN')}đ. Xem tại "Acc đã sở hữu".`,
          },
        ],
      })

      return { listing: updatedListing, newOwned, sellerId: listing.sellerId }
    })

    emitToUser(buyerId, 'balance:update', {})
    emitToUser(result.sellerId, 'balance:update', {})
    emitToUser(result.sellerId, 'notification', { type: 'MARKETPLACE', title: 'Đã bán thành công!' })
    checkAndGrantAchievements(result.sellerId)

    res.json({ success: true, data: result.listing, message: 'Mua tài khoản thành công' })
  } catch (e) {
    res.status(e.code || 500).json({ success: false, message: e.message })
  }
}

// ── Admin ─────────────────────────────────────────────────────────────
const adminGetListings = async (req, res) => {
  try {
    const { status } = req.query
    const where = status ? { status } : {}
    const listings = await prisma.marketplaceListing.findMany({
      where,
      include: {
        seller: { select: { username: true, displayName: true, email: true } },
        buyer: { select: { username: true, displayName: true } },
        ownedAccount: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: listings.map(withSnapshot) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminApproveListing = async (req, res) => {
  try {
    const listing = await prisma.marketplaceListing.findUnique({ where: { id: req.params.id } })
    if (!listing) return res.status(404).json({ success: false, message: 'Không tìm thấy tin đăng' })
    if (listing.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Tin đăng đã được xử lý' })

    const updated = await prisma.marketplaceListing.update({
      where: { id: listing.id },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: req.user.id },
    })

    await prisma.notification.create({
      data: {
        userId: listing.sellerId, type: 'MARKETPLACE', title: 'Tin đăng đã được duyệt!',
        message: `"${listing.title}" đã được duyệt và hiển thị công khai trên chợ trao đổi.`,
      },
    })
    emitToUser(listing.sellerId, 'notification', { type: 'MARKETPLACE', title: 'Tin đăng đã được duyệt!' })

    res.json({ success: true, data: updated })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminRejectListing = async (req, res) => {
  try {
    const { reason } = req.body
    const listing = await prisma.marketplaceListing.findUnique({ where: { id: req.params.id } })
    if (!listing) return res.status(404).json({ success: false, message: 'Không tìm thấy tin đăng' })
    if (listing.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Tin đăng đã được xử lý' })

    const updated = await prisma.marketplaceListing.update({
      where: { id: listing.id },
      data: { status: 'REJECTED', rejectReason: reason || null },
    })

    await prisma.notification.create({
      data: {
        userId: listing.sellerId, type: 'MARKETPLACE', title: 'Tin đăng bị từ chối',
        message: `"${listing.title}" đã bị từ chối${reason ? `: ${reason}` : ''}.`,
      },
    })
    emitToUser(listing.sellerId, 'notification', { type: 'MARKETPLACE', title: 'Tin đăng bị từ chối' })

    res.json({ success: true, data: updated })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminGetFeePercent = async (req, res) => {
  res.json({ success: true, data: { feePercent: await getFeePercent() } })
}

// Public — để user xem trước % phí sàn khi đăng bán
const getPublicFeePercent = async (req, res) => {
  res.json({ success: true, data: { feePercent: await getFeePercent() } })
}

const adminSetFeePercent = async (req, res) => {
  try {
    const { feePercent } = req.body
    const val = parseFloat(feePercent)
    if (![5, 10].includes(val)) return res.status(400).json({ success: false, message: 'Phí sàn chỉ chấp nhận 5% hoặc 10%' })

    await prisma.siteConfig.upsert({
      where: { key: 'marketplace_fee_percent' },
      create: { key: 'marketplace_fee_percent', value: String(val), group: 'marketplace', type: 'number' },
      update: { value: String(val) },
    })
    res.json({ success: true, data: { feePercent: val } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = {
  getListings, getListingDetail, getMySellableAccounts, getMyListings, getMyPurchases,
  createListing, cancelListing, buyListing,
  adminGetListings, adminApproveListing, adminRejectListing, adminGetFeePercent, adminSetFeePercent,
  getPublicFeePercent,
}
