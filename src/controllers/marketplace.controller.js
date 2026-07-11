const prisma = require('../config/prisma')
const { emitToUser, emitToAdmins } = require('../config/socket')
const { checkAndGrantAchievements } = require('./achievement.controller')

const DEFAULT_FEE_PERCENT = 10
const DEFAULT_CONTACT_ZALO = 'Liên hệ Zalo Admin để đặt cọc và nâng cấp quyền bán acc'

const getFeePercent = async () => {
  try {
    const cfg = await prisma.siteConfig.findUnique({ where: { key: 'marketplace_fee_percent' } })
    const val = parseFloat(cfg?.value)
    return Number.isFinite(val) && val > 0 ? val : DEFAULT_FEE_PERCENT
  } catch { return DEFAULT_FEE_PERCENT }
}

const getSellerContactInfo = async () => {
  try {
    const cfg = await prisma.siteConfig.findUnique({ where: { key: 'seller_permission_contact' } })
    return cfg?.value || DEFAULT_CONTACT_ZALO
  } catch { return DEFAULT_CONTACT_ZALO }
}

const parseSnapshot = (rec) => {
  try {
    return typeof rec.snapshotData === 'string' ? JSON.parse(rec.snapshotData) : rec.snapshotData
  } catch { return {} }
}

// Acc được coi là "có thông tin" nếu còn giữ bind email/sdt, hoặc facebook liên kết SỐNG (RIP/không liên kết vẫn tính là trắng)
const snapshotHasFullInfo = (snap) => !!(snap?.gameBindEmail || snap?.gameBindPhone || snap?.gameBindFacebook === 'LIVE')

const withSnapshot = (listing) => ({
  ...listing,
  snapshot: listing.ownedAccount ? parseSnapshot(listing.ownedAccount) : parseSnapshot(listing),
})

const SELLER_PUBLIC_SELECT = {
  id: true, username: true, displayName: true, avatar: true,
  sellerDepositAmount: true, sellerMaxSellPrice: true,
}

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
          seller: { select: SELLER_PUBLIC_SELECT },
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
        seller: { select: { ...SELLER_PUBLIC_SELECT, createdAt: true } },
        buyer: { select: { id: true, username: true, displayName: true } },
        ownedAccount: true,
      },
    })
    if (!listing) return res.status(404).json({ success: false, message: 'Không tìm thấy tin đăng' })
    res.json({ success: true, data: withSnapshot(listing) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Public: hồ sơ người bán (click từ trang chi tiết) ───────────────────
const getSellerProfile = async (req, res) => {
  try {
    const { sellerId } = req.params
    const seller = await prisma.user.findUnique({
      where: { id: sellerId },
      select: {
        id: true, username: true, displayName: true, avatar: true, createdAt: true,
        sellerTier: true, sellerDepositAmount: true, sellerMaxSellPrice: true,
      },
    })
    if (!seller) return res.status(404).json({ success: false, message: 'Không tìm thấy người bán' })

    const [soldCount, activeCount, ratingAgg, myRating] = await Promise.all([
      prisma.marketplaceListing.count({ where: { sellerId, status: 'SOLD' } }),
      prisma.marketplaceListing.count({ where: { sellerId, status: 'APPROVED' } }),
      prisma.sellerRating.aggregate({ where: { sellerId }, _avg: { stars: true }, _count: { stars: true } }),
      req.user ? prisma.sellerRating.findUnique({ where: { sellerId_raterId: { sellerId, raterId: req.user.id } } }) : null,
    ])

    res.json({
      success: true,
      data: {
        ...seller,
        soldCount,
        activeCount,
        avgRating: ratingAgg._avg.stars || 0,
        ratingCount: ratingAgg._count.stars || 0,
        myRating: myRating?.stars || 0,
      },
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Tin đang bán khác của người bán này (để hiện ở trang chi tiết + trang hồ sơ)
const getSellerListings = async (req, res) => {
  try {
    const { sellerId } = req.params
    const { excludeId, limit = 8 } = req.query
    const listings = await prisma.marketplaceListing.findMany({
      where: { sellerId, status: 'APPROVED', ...(excludeId ? { id: { not: excludeId } } : {}) },
      include: { seller: { select: SELLER_PUBLIC_SELECT }, ownedAccount: true },
      orderBy: { approvedAt: 'desc' },
      take: parseInt(limit),
    })
    res.json({ success: true, data: listings.map(withSnapshot) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Đánh giá sao cho người bán (upsert — mỗi user chỉ 1 đánh giá / người bán, sửa lại thì ghi đè)
const rateSeller = async (req, res) => {
  try {
    const { sellerId } = req.params
    const { stars, comment } = req.body
    const starsNum = parseInt(stars)

    if (sellerId === req.user.id) return res.status(400).json({ success: false, message: 'Không thể tự đánh giá bản thân' })
    if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
      return res.status(400).json({ success: false, message: 'Số sao phải từ 1 đến 5' })
    }

    const seller = await prisma.user.findUnique({ where: { id: sellerId }, select: { id: true } })
    if (!seller) return res.status(404).json({ success: false, message: 'Không tìm thấy người bán' })

    const rating = await prisma.sellerRating.upsert({
      where: { sellerId_raterId: { sellerId, raterId: req.user.id } },
      create: { sellerId, raterId: req.user.id, stars: starsNum, comment: comment || null },
      update: { stars: starsNum, comment: comment || null },
    })

    const ratingAgg = await prisma.sellerRating.aggregate({ where: { sellerId }, _avg: { stars: true }, _count: { stars: true } })

    res.json({
      success: true,
      data: { myRating: rating.stars, avgRating: ratingAgg._avg.stars || 0, ratingCount: ratingAgg._count.stars || 0 },
      message: 'Đã gửi đánh giá',
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── User ──────────────────────────────────────────────────────────────
// Trạng thái cấp phép bán acc của user hiện tại — FE dùng để hiện gate hoặc form đăng bán
const getMySellerStatus = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        sellerTier: true, sellerTierNote: true, sellerTierUpdatedAt: true,
        sellerDepositAmount: true, sellerMaxSellPrice: true,
      },
    })
    res.json({
      success: true,
      data: {
        sellerTier: user.sellerTier,
        note: user.sellerTierNote,
        depositAmount: user.sellerDepositAmount,
        maxSellPrice: user.sellerMaxSellPrice,
        updatedAt: user.sellerTierUpdatedAt,
        contactInfo: await getSellerContactInfo(),
      },
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Danh sách acc đang sở hữu mà CHƯA đem bán (để chọn khi đăng tin)
// Kèm cờ hasFullInfo + requiredTier để FE biết acc nào cần cấp nào mới được bán
const getMySellableAccounts = async (req, res) => {
  try {
    const accounts = await prisma.userOwnedAccount.findMany({
      where: { userId: req.user.id, marketplaceListing: null },
      orderBy: { receivedAt: 'desc' },
    })
    const data = accounts.map(acc => {
      const snap = parseSnapshot(acc)
      const hasFullInfo = snapshotHasFullInfo(snap)
      return { ...acc, snapshot: snap, hasFullInfo, requiredTier: hasFullInfo ? 'TIER_FULL' : 'TIER_BLANK' }
    })
    res.json({ success: true, data })
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

// Thứ tự cấp quyền để so sánh "đủ hay chưa đủ"
const TIER_RANK = { NONE: 0, TIER_BLANK: 1, TIER_FULL: 2 }

const createListing = async (req, res) => {
  try {
    const {
      title, description, price, contactInfo,
      rank, server, champions, skins, level,
      gameUsername, gamePassword, gameBindEmail, gameBindPhone, gameBindFacebook,
    } = req.body

    const priceNum = parseFloat(price)
    if (!priceNum || priceNum <= 0) return res.status(400).json({ success: false, message: 'Giá bán không hợp lệ' })
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Vui lòng nhập tiêu đề tin đăng' })
    if (!contactInfo?.trim()) return res.status(400).json({ success: false, message: 'Vui lòng nhập thông tin liên hệ (Zalo/SĐT) để người mua liên hệ' })

    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { sellerTier: true, sellerMaxSellPrice: true },
    })
    if (!me.sellerTier || me.sellerTier === 'NONE') {
      return res.status(403).json({
        success: false,
        code: 'SELLER_NOT_AUTHORIZED',
        message: `Bạn chưa được cấp quyền bán acc. ${await getSellerContactInfo()}`,
      })
    }

    const hasFullInfo = !!(gameBindEmail || gameBindPhone || gameBindFacebook === 'LIVE')
    const requiredTier = hasFullInfo ? 'TIER_FULL' : 'TIER_BLANK'

    if (TIER_RANK[me.sellerTier] < TIER_RANK[requiredTier]) {
      return res.status(403).json({
        success: false,
        code: 'SELLER_TIER_TOO_LOW',
        message: hasFullInfo
          ? `Acc này còn thông tin bind (email/sdt/fb) — cần cấp "Bán acc có thông tin" mới đăng bán được. ${await getSellerContactInfo()}`
          : `Bạn cần được cấp quyền bán acc trước. ${await getSellerContactInfo()}`,
      })
    }

    const maxSellPrice = me.sellerMaxSellPrice ? parseFloat(me.sellerMaxSellPrice) : null
    if (maxSellPrice && priceNum > maxSellPrice) {
      return res.status(403).json({
        success: false,
        code: 'PRICE_EXCEEDS_LIMIT',
        message: `Giá bán vượt quá mức cho phép theo cọc của bạn (tối đa ${maxSellPrice.toLocaleString('vi-VN')}đ).`,
      })
    }

    const images = req.files?.map((f, i) => ({ url: f.path, publicId: f.filename, sortOrder: i })) || []
    if (images.length === 0) return res.status(400).json({ success: false, message: 'Vui lòng tải lên ít nhất 1 hình ảnh acc' })

    const snapshot = {
      title: title.trim(),
      rank: rank || null,
      server: server || null,
      champions: champions ? parseInt(champions) : null,
      skins: skins ? parseInt(skins) : null,
      level: level ? parseInt(level) : null,
      gameUsername: gameUsername || null,
      gamePassword: gamePassword || null,
      gameBindEmail: gameBindEmail || null,
      gameBindPhone: gameBindPhone || null,
      gameBindFacebook: gameBindFacebook || 'NONE',
      images,
      thumbnailUrl: images[0]?.url || null,
    }

    const feePercent = await getFeePercent()

    const listing = await prisma.marketplaceListing.create({
      data: {
        sellerId: req.user.id,
        title: title.trim(),
        description: description || null,
        price: priceNum,
        feePercent,
        hasFullInfo,
        contactInfo: contactInfo.trim(),
        snapshotData: JSON.stringify(snapshot),
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

      const snapshotToCopy = listing.ownedAccount ? listing.ownedAccount.snapshotData : listing.snapshotData

      const newOwned = await tx.userOwnedAccount.create({
        data: {
          userId: buyerId,
          accountId: listing.ownedAccount?.accountId || null,
          sourceType: 'MARKETPLACE_PURCHASE',
          sourceId: listing.id,
          snapshotData: snapshotToCopy,
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

// ── Admin: tin đăng ─────────────────────────────────────────────────────
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

// ── Admin: cấu hình chung (phí sàn tự do + nội dung liên hệ cấp quyền) ──
const adminGetConfig = async (req, res) => {
  res.json({ success: true, data: { feePercent: await getFeePercent(), contactInfo: await getSellerContactInfo() } })
}

// Public — để user xem trước % phí sàn khi đăng bán
const getPublicFeePercent = async (req, res) => {
  res.json({ success: true, data: { feePercent: await getFeePercent() } })
}

const adminSetConfig = async (req, res) => {
  try {
    const { feePercent, contactInfo } = req.body

    if (feePercent !== undefined) {
      const val = parseFloat(feePercent)
      if (!Number.isFinite(val) || val < 0 || val > 100) {
        return res.status(400).json({ success: false, message: 'Phí sàn phải là số từ 0 đến 100' })
      }
      await prisma.siteConfig.upsert({
        where: { key: 'marketplace_fee_percent' },
        create: { key: 'marketplace_fee_percent', value: String(val), group: 'marketplace', type: 'number' },
        update: { value: String(val) },
      })
    }

    if (contactInfo !== undefined) {
      await prisma.siteConfig.upsert({
        where: { key: 'seller_permission_contact' },
        create: { key: 'seller_permission_contact', value: contactInfo, group: 'marketplace', type: 'text' },
        update: { value: contactInfo },
      })
    }

    res.json({ success: true, data: { feePercent: await getFeePercent(), contactInfo: await getSellerContactInfo() } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Admin: cấp quyền bán acc cho user ────────────────────────────────────
const adminGetSellers = async (req, res) => {
  try {
    const { search } = req.query
    const where = search
      ? { OR: [{ username: { contains: search } }, { displayName: { contains: search } }, { email: { contains: search } }] }
      : { sellerTier: { not: 'NONE' } }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, username: true, displayName: true, email: true, avatar: true,
        sellerTier: true, sellerTierNote: true, sellerTierUpdatedAt: true,
        sellerDepositAmount: true, sellerMaxSellPrice: true,
        _count: { select: { marketplaceListings: true } },
      },
      orderBy: { sellerTierUpdatedAt: 'desc' },
      take: 50,
    })
    res.json({ success: true, data: users })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminSetSellerTier = async (req, res) => {
  try {
    const { userId, sellerTier, note, depositAmount, maxSellPrice } = req.body
    if (!['NONE', 'TIER_BLANK', 'TIER_FULL'].includes(sellerTier)) {
      return res.status(400).json({ success: false, message: 'Cấp quyền không hợp lệ' })
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        sellerTier,
        sellerTierNote: note || null,
        sellerDepositAmount: depositAmount !== undefined && depositAmount !== '' ? parseFloat(depositAmount) : null,
        sellerMaxSellPrice: maxSellPrice !== undefined && maxSellPrice !== '' ? parseFloat(maxSellPrice) : null,
        sellerTierUpdatedAt: new Date(),
        sellerTierUpdatedBy: req.user.id,
      },
    })

    const TIER_LABEL = { NONE: 'không được phép bán', TIER_BLANK: 'bán acc trắng thông tin', TIER_FULL: 'bán acc trắng & có thông tin' }
    await prisma.notification.create({
      data: {
        userId, type: 'MARKETPLACE', title: 'Cập nhật quyền bán acc',
        message: `Quyền bán acc của bạn đã được cập nhật: ${TIER_LABEL[sellerTier]}.`,
      },
    })
    emitToUser(userId, 'notification', { type: 'MARKETPLACE', title: 'Cập nhật quyền bán acc' })

    res.json({ success: true, data: user })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = {
  getListings, getListingDetail, getMySellerStatus, getMySellableAccounts, getMyListings, getMyPurchases,
  createListing, cancelListing, buyListing,
  getSellerProfile, getSellerListings, rateSeller,
  adminGetListings, adminApproveListing, adminRejectListing,
  adminGetConfig, adminSetConfig, getPublicFeePercent,
  adminGetSellers, adminSetSellerTier,
}