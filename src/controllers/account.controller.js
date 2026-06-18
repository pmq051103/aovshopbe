const { deleteImage } = require('../config/cloudinary')
const { emitToAll, emitToAdmins } = require('../config/socket')
const prisma = require('../config/prisma')

const getAccounts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 12,
      rank,
      server,
      minPrice,
      maxPrice,
      search,
      sort = 'newest',
      status = 'AVAILABLE',
      featured,
      categoryId,
      minSkins,
      maxSkins,
      minChampions,
      maxChampions,
      skinName,
      gameBindFacebook,
      hasEmail,
      hasPhone,
      blankInfo,
    } = req.query

    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {
      status: status.toUpperCase(),
    }

    if (rank) where.rank = rank
    if (server) where.server = server

    if (minPrice || maxPrice) {
      where.price = {
        ...(minPrice && { gte: parseFloat(minPrice) }),
        ...(maxPrice && { lte: parseFloat(maxPrice) }),
      }
    }

    if (minSkins || maxSkins) {
      where.skins = {
        ...(minSkins && { gte: parseInt(minSkins) }),
        ...(maxSkins && { lte: parseInt(maxSkins) }),
      }
    }

    if (minChampions || maxChampions) {
      where.champions = {
        ...(minChampions && { gte: parseInt(minChampions) }),
        ...(maxChampions && { lte: parseInt(maxChampions) }),
      }
    }

    if (search) {
      where.OR = [
        { title: { contains: search } },
        { code: { contains: search } },
        { rank: { contains: search } },
      ]
    }

    if (featured === 'true') where.isFeatured = true

    if (skinName) {
      where.skins_rel = {
        some: {
          skinName: {
            contains: skinName,
          },
        },
      }
    }

    if (categoryId) {
      where.categoryRelations = {
        some: {
          categoryId,
        },
      }
    }

    if (hasEmail === 'true') {
      where.gameBindEmail = {
        not: null,
      }
    }

    if (hasPhone === 'true') {
      where.gameBindPhone = {
        not: null,
      }
    }

    if (blankInfo === 'true') {
      where.gameBindEmail = null
      where.gameBindPhone = null
    }

    if (gameBindFacebook) {
      where.gameBindFacebook = gameBindFacebook.toUpperCase()
    }

    const orderBy = {
      newest: { createdAt: 'desc' },
      oldest: { createdAt: 'asc' },
      price_asc: { price: 'asc' },
      price_desc: { price: 'desc' },
      popular: { viewCount: 'desc' },
      skins_desc: { skins: 'desc' },
      champions_desc: { champions: 'desc' },
    }[sort] || { createdAt: 'desc' }

    const [accounts, total] = await Promise.all([
      prisma.gameAccount.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy,
        select: {
          id: true,
          code: true,
          title: true,
          description: true,
          price: true,
          originalPrice: true,
          rank: true,
          server: true,
          champions: true,
          skins: true,
          level: true,
          winRate: true,
          matches: true,
          gems: true,
          vouchers: true,
          status: true,
          isVerified: true,
          isFeatured: true,
          isNew: true,
          viewCount: true,
          thumbnailUrl: true,
          thumbnailId: true,
          tags: true,
          gameUsername: true,
          gamePassword: true,
          gameBindEmail: true,
          gameBindPhone: true,
          gameBindFacebook: true,
          createdAt: true,
          images: {
            orderBy: {
              sortOrder: 'asc',
            },
          },
          skins_rel: {
            select: {
              skinName: true,
              heroName: true,
            },
          },
          categoryRelations: {
            include: {
              category: true,
            },
          },
        },
      }),

      prisma.gameAccount.count({
        where,
      }),
    ])

    const formattedAccounts = accounts.map(acc => ({
      ...acc,
      price: acc.price !== null ? Number(acc.price) : null,
      originalPrice: acc.originalPrice !== null ? Number(acc.originalPrice) : null,
      winRate: acc.winRate !== null ? Number(acc.winRate) : null,
    }))

    res.json({
      success: true,
      data: formattedAccounts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: 'Lỗi lấy danh sách tài khoản',
      error: e.message,
    })
  }
}

const getAccountById = async (req, res) => {
  try {
    const account = await prisma.gameAccount.findUnique({
      where: { id: req.params.id },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        skins_rel: { orderBy: { skinName: 'asc' } },
        categoryRelations: {
          include: {
            category: true,
          },
        },
      },
    })

    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tài khoản',
      })
    }

    // await prisma.gameAccount.update({
    //   where: { id: account.id },
    //   data: {
    //     viewCount: {
    //       increment: 1,
    //     },
    //   },
    // })

    const isBuyer = account.status === 'SOLD' && req.user?.id === account.soldToId
    const isAdmin = req.user?.role === 'ADMIN'

    const data = {
      ...account,
      price: account.price !== null ? Number(account.price) : null,
      originalPrice: account.originalPrice !== null ? Number(account.originalPrice) : null,
      winRate: account.winRate !== null ? Number(account.winRate) : null,

      // Cho FE biết acc có liên kết gì, nhưng không lộ full email / sđt
      hasBindEmail: !!account.gameBindEmail,
      hasBindPhone: !!account.gameBindPhone,
      gameBindFacebook: account.gameBindFacebook || 'NONE',
    }

    if (!isBuyer && !isAdmin) {
      data.gameUsername = null
      data.gamePassword = null
      data.gameBindEmail = null
      data.gameBindPhone = null
    }

    res.json({
      success: true,
      data,
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: 'Lỗi lấy thông tin tài khoản',
      error: e.message,
    })
  }
}

// ── BUY với coupon support ────────────────────────────────────
const buyAccount = async (req, res) => {
  try {
    const { couponCode } = req.body || {}

    const account = await prisma.gameAccount.findUnique({
      where: { id: req.params.id },
      include: { images: { orderBy: { sortOrder: 'asc' } } }
    })
    if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' })
    if (account.status !== 'AVAILABLE') return res.status(400).json({ success: false, message: 'Tài khoản đã được bán' })

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })

    let coupon = null
    let discountAmount = 0

    if (couponCode) {
      coupon = await prisma.coupon.findUnique({ where: { code: couponCode.toUpperCase() } })
      if (!coupon || !coupon.isActive)
        return res.status(400).json({ success: false, message: 'Mã coupon không tồn tại hoặc đã hết hiệu lực' })

      const now = new Date()
      if (coupon.startDate && now < coupon.startDate)
        return res.status(400).json({ success: false, message: 'Coupon chưa đến thời gian sử dụng' })
      if (coupon.endDate && now > coupon.endDate)
        return res.status(400).json({ success: false, message: 'Coupon đã hết hạn' })
      if (coupon.usageCount >= coupon.usageLimit)
        return res.status(400).json({ success: false, message: 'Coupon đã hết lượt sử dụng' })
      if (parseFloat(account.price) < parseFloat(coupon.minPurchase))
        return res.status(400).json({ success: false, message: `Đơn tối thiểu ${parseInt(coupon.minPurchase).toLocaleString('vi-VN')}đ` })

      // Kiểm tra user đã dùng coupon này chưa
      const userUsage = await prisma.couponUsage.findFirst({
        where: { couponId: coupon.id, userId: req.user.id }
      })
      if (userUsage)
        return res.status(400).json({ success: false, message: 'Bạn đã sử dụng mã giảm giá này rồi' })

      if (coupon.type === 'PERCENT') {
        discountAmount = parseFloat(account.price) * parseFloat(coupon.value) / 100
        if (coupon.maxDiscount) discountAmount = Math.min(discountAmount, parseFloat(coupon.maxDiscount))
      } else if (coupon.type === 'FIXED') {
        discountAmount = Math.min(parseFloat(coupon.value), parseFloat(account.price))
      }
      discountAmount = Math.round(discountAmount)
    }

    const finalPrice = Math.max(0, parseFloat(account.price) - discountAmount)

    if (parseFloat(user.balance) < finalPrice) {
      return res.status(400).json({
        success: false,
        message: 'Số dư không đủ',
        required: finalPrice,
        balance: user.balance,
        discount: discountAmount,
        finalPrice
      })
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Trừ tiền user
      const updatedUser = await tx.user.update({
        where: { id: req.user.id },
        data: { balance: { decrement: finalPrice }, totalSpent: { increment: finalPrice } }
      })

      // 2. Cập nhật trạng thái account
      const updatedAccount = await tx.gameAccount.update({
        where: { id: account.id },
        data: { status: 'SOLD', soldAt: new Date(), soldToId: req.user.id }
      })

      // 3. Tạo order trước để có orderId
      const order = await tx.order.create({
        data: {
          orderCode: `ORD-${Date.now().toString(36).toUpperCase()}`,
          userId: req.user.id,
          totalAmount: account.price,
          discountAmount: discountAmount,
          finalAmount: finalPrice,
          status: 'COMPLETED',
          completedAt: new Date(),
          couponId: coupon?.id || null,
          items: {
            create: {
              gameAccountId: account.id,
              gameAccountCode: account.code,
              gameAccountTitle: account.title,
              gameAccountRank: account.rank,
              gameAccountServer: account.server,
              price: finalPrice,
              gameUsername: account.gameUsername,
              gamePassword: account.gamePassword,
              gameBindEmail: account.gameBindEmail,
              gameBindPhone: account.gameBindPhone,
              gameBindFacebook: account.gameBindFacebook,
            }
          }
        }
      })

      // 4. Cập nhật coupon & tạo CouponUsage SAU KHI có orderId
      if (coupon) {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { usageCount: { increment: 1 } }
        })
        await tx.couponUsage.create({
          data: { couponId: coupon.id, userId: req.user.id, orderId: order.id }
        })
      }

      // 5. Lưu vào kho acc user
      await tx.userOwnedAccount.create({
        data: {
          userId: req.user.id,
          accountId: account.id,
          sourceType: 'PURCHASED',
          sourceId: order.id,
          snapshotData: JSON.stringify({
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
            finalPrice,
            discountAmount,
            thumbnailUrl: account.thumbnailUrl,
            images: account.images?.map(i => ({ url: i.url, sortOrder: i.sortOrder })) || [],
            gameUsername: account.gameUsername,
            gamePassword: account.gamePassword,
            gameBindEmail: account.gameBindEmail,
            gameBindPhone: account.gameBindPhone,
            gameBindFacebook: account.gameBindFacebook,
            tags: account.tags,
          })
        }
      })

      // 6. Ghi transaction lịch sử
      await tx.transaction.create({
        data: {
          userId: req.user.id,
          type: 'PURCHASE',
          amount: -finalPrice,
          balanceBefore: user.balance,
          balanceAfter: updatedUser.balance,
          description: `Mua acc ${account.code}${discountAmount > 0 ? ` (giảm ${discountAmount.toLocaleString('vi-VN')}đ)` : ''}`,
          //gameAccountId: account.id
        }
      })

      // 7. Tạo notification
      await tx.notification.create({
        data: {
          userId: req.user.id,
          type: 'PURCHASE',
          title: '🛒 Mua tài khoản thành công!',
          message: `Tài khoản ${account.code} đã vào kho của bạn.${discountAmount > 0 ? ` Tiết kiệm ${discountAmount.toLocaleString('vi-VN')}đ!` : ''}`,
          data: { accountId: account.id, code: account.code, orderId: order.id }
        }
      })

      return { updatedAccount, updatedUser, order }
    })

    emitToAll('account:sold', { accountId: account.id, code: account.code })
    emitToAdmins('admin:new_order', { accountId: account.id, code: account.code })
    const io = req.app.get('io')
    io?.to(`user:${req.user.id}`).emit('notification', { type: 'PURCHASE', title: 'Mua thành công!' })

    res.json({
      success: true,
      message: discountAmount > 0
        ? `Mua tài khoản thành công! Tiết kiệm ${discountAmount.toLocaleString('vi-VN')}đ với mã ${couponCode}`
        : 'Mua tài khoản thành công',
      data: {
        account: result.updatedAccount,
        gameCredentials: {
          username: account.gameUsername,
          password: account.gamePassword,
          bindEmail: account.gameBindEmail,
          bindPhone: account.gameBindPhone,
          bindFacebook: account.gameBindFacebook,
        },
        newBalance: result.updatedUser.balance,
        discountAmount,
        finalPrice,
        orderId: result.order.id,
      }
    })
  } catch (e) {
    console.error('BUY ACCOUNT ERROR:', e)

    if (e.code === 'P2002') {
      // Phân biệt rõ unique constraint bị vi phạm ở đâu
      const target = (e.meta?.target || '').toString()
      if (target.includes('coupon')) {
        return res.status(400).json({ success: false, message: 'Bạn đã sử dụng mã giảm giá này rồi' })
      }
      // gameAccountId unique trên Transaction hoặc conflict khác
      return res.status(400).json({ success: false, message: 'Tài khoản này vừa được mua bởi người khác, vui lòng thử lại' })
    }

    res.status(500).json({ success: false, message: 'Lỗi mua tài khoản', error: e.message })
  }
}

// ── Validate coupon for account (preview discount) ─────────
const previewCoupon = async (req, res) => {
  try {
    const { couponCode, accountId } = req.body
    if (!couponCode || !accountId) return res.status(400).json({ success: false, message: 'Thiếu thông tin' })

    const [coupon, account] = await Promise.all([
      prisma.coupon.findUnique({ where: { code: couponCode.toUpperCase() } }),
      prisma.gameAccount.findUnique({ where: { id: accountId }, select: { price: true } })
    ])

    if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản' })
    if (!coupon || !coupon.isActive) return res.status(400).json({ success: false, message: 'Mã coupon không hợp lệ' })

    const now = new Date()
    if (coupon.endDate && now > coupon.endDate) return res.status(400).json({ success: false, message: 'Coupon đã hết hạn' })
    if (coupon.usageCount >= coupon.usageLimit) return res.status(400).json({ success: false, message: 'Coupon hết lượt' })
    if (parseFloat(account.price) < parseFloat(coupon.minPurchase)) return res.status(400).json({ success: false, message: `Đơn tối thiểu ${parseInt(coupon.minPurchase).toLocaleString('vi-VN')}đ` })

    const userUsage = await prisma.couponUsage.findFirst({
      where: {
        couponId: coupon.id,
        userId: req.user.id
      }
    })

    if (userUsage) {
      return res.status(400).json({
        success: false,
        message: 'Bạn đã sử dụng mã giảm giá này rồi'
      })
    }
    let discount = 0
    if (coupon.type === 'PERCENT') {
      discount = parseFloat(account.price) * parseFloat(coupon.value) / 100
      if (coupon.maxDiscount) discount = Math.min(discount, parseFloat(coupon.maxDiscount))
    } else if (coupon.type === 'FIXED') {
      discount = Math.min(parseFloat(coupon.value), parseFloat(account.price))
    }
    discount = Math.round(discount)
    const finalPrice = Math.max(0, parseFloat(account.price) - discount)

    res.json({ success: true, data: { coupon, discount, finalPrice, originalPrice: account.price } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN CRUD ────────────────────────────────────────────────
const createAccount = async (req, res) => {
  try {
    const parsedImages = req.files?.map((f, i) => ({
      url: f.path,
      publicId: f.filename,
      sortOrder: i
    })) || []

    const skinNames = req.body.skinNames
      ? req.body.skinNames.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
      : []

    const lastAccounts = await prisma.gameAccount.findMany({
      where: { code: { startsWith: 'LQ' } },
      select: { code: true }
    })

    let maxNumber = 0
    lastAccounts.forEach(acc => {
      const match = acc.code?.match(/^LQ(\d+)$/)
      if (match) {
        const num = parseInt(match[1])
        if (num > maxNumber) maxNumber = num
      }
    })

    const nextCode = `LQ${(maxNumber + 1).toString().padStart(5, '0')}`

    const account = await prisma.gameAccount.create({
      data: {
        code: nextCode,
        title: req.body.title,
        description: req.body.description || null,
        price: parseFloat(req.body.price),
        // FIX: parse đúng, trả null nếu rỗng
        originalPrice: req.body.originalPrice !== undefined && req.body.originalPrice !== ''
          ? parseFloat(req.body.originalPrice)
          : null,
        server: req.body.server || 'Server 1',
        rank: req.body.rank || 'Vàng',
        champions: parseInt(req.body.champions) || 0,
        skins: parseInt(req.body.skins) || skinNames.length || 0,
        level: parseInt(req.body.level) || 1,
        // FIX: parse đúng, trả null nếu rỗng
        winRate: req.body.winRate !== undefined && req.body.winRate !== ''
          ? parseFloat(req.body.winRate)
          : null,
        matches: parseInt(req.body.matches) || 0,
        gems: parseInt(req.body.gems) || 0,
        vouchers: parseInt(req.body.vouchers) || 0,
        gameUsername: req.body.gameUsername || null,
        gamePassword: req.body.gamePassword || null,
        gameBindEmail: req.body.gameBindEmail || null,
        gameBindPhone: req.body.gameBindPhone || null,
        gameBindFacebook: req.body.gameBindFacebook || 'NONE',
        installmentDays: req.body.installmentDays !== undefined && req.body.installmentDays !== ''
          ? parseInt(req.body.installmentDays)
          : null,
        loginRevealPercent: req.body.loginRevealPercent !== undefined && req.body.loginRevealPercent !== ''
          ? parseFloat(req.body.loginRevealPercent)
          : null,
        isFeatured: req.body.isFeatured === 'true' || req.body.isFeatured === true,
        isNew: req.body.isNew === 'true' || req.body.isNew === true,
        isVerified: req.body.isVerified === 'true' || req.body.isVerified === true,
        thumbnailUrl: parsedImages[0]?.url || null,
        thumbnailId: parsedImages[0]?.publicId || null,
        images: { create: parsedImages },
        skins_rel: {
          create: skinNames.map(name => ({ skinName: name }))
        },
        categoryRelations: req.body.categoryId
          ? {
            create: {
              categoryId: req.body.categoryId
            }
          }
          : undefined

      },
      include: {
        images: true,
        skins_rel: true,
        categoryRelations: {
          include: {
            category: true
          }
        }
      }
    })

    res.status(201).json({ success: true, message: 'Tạo tài khoản thành công', data: account })
  } catch (e) {
    console.error('CREATE ACCOUNT ERROR:', e)
    res.status(500).json({ success: false, message: 'Lỗi tạo tài khoản', error: e.message })
  }
}

const updateAccount = async (req, res) => {
  try {
    const skinNamesRaw = req.body.skinNames
    const skinNames = skinNamesRaw
      ? skinNamesRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
      : null

    // skinsData: mảng đầy đủ { skinName, heroName, rarity, templateId } từ selectedSkins
    let skinsData = null
    if (req.body.skinsData) {
      try { skinsData = JSON.parse(req.body.skinsData) } catch {}
    }

    const newImages = req.files?.map((f, i) => ({
      url: f.path,
      publicId: f.filename,
      sortOrder: i
    })) || []

    const data = {}

    if (req.body.title !== undefined) data.title = req.body.title
    if (req.body.description !== undefined) data.description = req.body.description || null
    if (req.body.price !== undefined && req.body.price !== '') data.price = parseFloat(req.body.price)
    if (req.body.server !== undefined) data.server = req.body.server
    if (req.body.rank !== undefined) data.rank = req.body.rank
    if (req.body.champions !== undefined && req.body.champions !== '') data.champions = parseInt(req.body.champions)
    if (req.body.skins !== undefined && req.body.skins !== '') data.skins = parseInt(req.body.skins)
    if (req.body.level !== undefined && req.body.level !== '') data.level = parseInt(req.body.level)
    if (req.body.matches !== undefined && req.body.matches !== '') data.matches = parseInt(req.body.matches)
    if (req.body.gems !== undefined && req.body.gems !== '') data.gems = parseInt(req.body.gems)
    if (req.body.vouchers !== undefined && req.body.vouchers !== '') data.vouchers = parseInt(req.body.vouchers)

    if (req.body.gameUsername !== undefined) data.gameUsername = req.body.gameUsername || null
    if (req.body.gamePassword !== undefined) data.gamePassword = req.body.gamePassword || null
    if (req.body.gameBindEmail !== undefined) data.gameBindEmail = req.body.gameBindEmail || null
    if (req.body.gameBindPhone !== undefined) data.gameBindPhone = req.body.gameBindPhone || null
    if (req.body.gameBindFacebook !== undefined) data.gameBindFacebook = req.body.gameBindFacebook || 'NONE'

    if (req.body.installmentDays !== undefined) {
      data.installmentDays = req.body.installmentDays !== '' ? parseInt(req.body.installmentDays) : null
    }
    if (req.body.loginRevealPercent !== undefined) {
      data.loginRevealPercent = req.body.loginRevealPercent !== '' ? parseFloat(req.body.loginRevealPercent) : null
    }

    if (req.body.status !== undefined) data.status = req.body.status
    if (req.body.isFeatured !== undefined) data.isFeatured = req.body.isFeatured === 'true' || req.body.isFeatured === true
    if (req.body.isNew !== undefined) data.isNew = req.body.isNew === 'true' || req.body.isNew === true
    if (req.body.isVerified !== undefined) data.isVerified = req.body.isVerified === 'true' || req.body.isVerified === true

    if (req.body.originalPrice !== undefined) {
      data.originalPrice = req.body.originalPrice !== '' ? parseFloat(req.body.originalPrice) : null
    }

    if (req.body.winRate !== undefined) {
      data.winRate = req.body.winRate !== '' ? parseFloat(req.body.winRate) : null
    }

    const oldAccount = await prisma.gameAccount.findUnique({
      where: { id: req.params.id },
      include: { images: true }
    })

    if (!oldAccount) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tài khoản'
      })
    }

    if (newImages.length > 0) {
      data.thumbnailUrl = newImages[0].url
      data.thumbnailId = newImages[0].publicId
    }

    const account = await prisma.$transaction(async (tx) => {
  if (skinsData !== null || skinNames !== null) {
    await tx.accountSkin.deleteMany({
      where: { accountId: req.params.id }
    })

    const finalSkins = skinsData !== null
      ? skinsData
      : skinNames.map(name => ({
          skinName: name,
          heroName: null,
          rarity: null,
          templateId: null,
        }))

    if (finalSkins.length > 0) {
      await tx.accountSkin.createMany({
        data: finalSkins.map(s => ({
          accountId: req.params.id,
          skinName: s.skinName,
          heroName: s.heroName || null,
          tier: s.rarity || null,
          templateId: s.templateId || null,
          detectedBy: s.templateId ? 'AI' : 'MANUAL',
          isConfirmed: true,
        }))
      })
    }

    data.skins = finalSkins.length
  }

  if (newImages.length > 0) {
    await tx.gameAccountImage.deleteMany({
      where: { accountId: req.params.id }
    })

    await tx.gameAccountImage.createMany({
      data: newImages.map(img => ({
        accountId: req.params.id,
        url: img.url,
        publicId: img.publicId,
        sortOrder: img.sortOrder
      }))
    })
  }

  if (req.body.categoryId !== undefined) {
    await tx.accountCategoryRelation.deleteMany({
      where: { accountId: req.params.id }
    })

    if (req.body.categoryId) {
      await tx.accountCategoryRelation.create({
        data: {
          accountId: req.params.id,
          categoryId: req.body.categoryId
        }
      })
    }
  }

  return tx.gameAccount.update({
    where: { id: req.params.id },
    data,
    include: {
      images: { orderBy: { sortOrder: 'asc' } },
      skins_rel: true,
      categoryRelations: {
        include: {
          category: true
        }
      }
    }
  })
}, {
  timeout: 15000,
  maxWait: 10000
})

    if (newImages.length > 0) {
      const publicIds = new Set()

      oldAccount.images?.forEach(img => {
        if (img.publicId) publicIds.add(img.publicId)
      })

      if (oldAccount.thumbnailId) {
        publicIds.add(oldAccount.thumbnailId)
      }

      for (const publicId of publicIds) {
        await deleteImage(publicId)
      }
    }

    res.json({
      success: true,
      message: 'Cập nhật tài khoản thành công',
      data: account
    })
  } catch (e) {
    console.error('UPDATE ACCOUNT ERROR:', e)

    if (req.files?.length > 0) {
      for (const file of req.files) {
        await deleteImage(file.filename)
      }
    }

    res.status(500).json({
      success: false,
      message: 'Lỗi cập nhật tài khoản',
      error: e.message
    })
  }
}

const deleteAccount = async (req, res) => {
  try {
    const account = await prisma.gameAccount.findUnique({
      where: { id: req.params.id },
      include: { images: true }
    })

    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy tài khoản'
      })
    }

    const publicIds = new Set()

    account.images?.forEach(img => {
      if (img.publicId) publicIds.add(img.publicId)
    })

    if (account.thumbnailId) {
      publicIds.add(account.thumbnailId)
    }

    await prisma.gameAccount.delete({
      where: { id: req.params.id }
    })

    for (const publicId of publicIds) {
      await deleteImage(publicId)
    }

    res.json({
      success: true,
      message: 'Xóa tài khoản thành công'
    })
  } catch (e) {
    console.error('DELETE ACCOUNT ERROR:', e)

    res.status(500).json({
      success: false,
      message: 'Lỗi xóa tài khoản',
      error: e.message
    })
  }
}

const getFilters = async (req, res) => {
  try {
    const [ranks, servers, priceRange, skinRange] = await Promise.all([
      prisma.gameAccount.findMany({ where: { status: 'AVAILABLE' }, select: { rank: true }, distinct: ['rank'] }),
      prisma.gameAccount.findMany({ where: { status: 'AVAILABLE' }, select: { server: true }, distinct: ['server'] }),
      prisma.gameAccount.aggregate({ where: { status: 'AVAILABLE' }, _min: { price: true, skins: true, champions: true }, _max: { price: true, skins: true, champions: true } }),
      prisma.accountSkin.groupBy({ by: ['skinName'], _count: true, orderBy: { _count: { skinName: 'desc' } }, take: 20 })
    ])
    res.json({ success: true, data: { ranks: ranks.map(r => r.rank), servers: servers.map(s => s.server), priceRange, popularSkins: skinRange } })
  } catch (e) { res.status(500).json({ success: false, message: 'Lỗi lấy filter' }) }
}

module.exports = { getAccounts, getAccountById, buyAccount, previewCoupon, createAccount, updateAccount, deleteAccount, getFilters }