const prisma = require('../config/prisma')
const logger = require('../config/logger')
const { emitToAll } = require('../config/socket')

// ── USER ──────────────────────────────────────────────────────────────────────

// GET /mystery-box/categories — danh sách category (public)
const getCategories = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.max(parseInt(req.query.limit) || 12, 1)
    const skip = (page - 1) * limit

    const where = { isActive: true }

    const [categories, total] = await Promise.all([
      prisma.mysteryBoxCategory.findMany({
        where,
        skip,
        take: limit,
        orderBy: { sortOrder: 'asc' },
        include: {
          _count: {
            select: {
              accounts: { where: { isSold: false } },
            },
          },
        },
      }),
      prisma.mysteryBoxCategory.count({ where }),
    ])

    const result = categories.map(cat => ({
      ...cat,
      availableCount: cat._count.accounts,
    }))

    res.json({
      success: true,
      data: result,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// GET /mystery-box/categories/:slug — chi tiết category + accounts (blurred)
const getCategoryBySlug = async (req, res) => {
  try {
    const { slug } = req.params
    const { page = 1, limit = 12, rarity, search } = req.query

    const category = await prisma.mysteryBoxCategory.findUnique({
      where: { slug, isActive: true }
    })
    if (!category) return res.status(404).json({ success: false, message: 'Không tìm thấy category' })

    const where = { categoryId: category.id, isSold: false }
    if (rarity && rarity !== 'ALL') where.rarity = rarity
    if (search) {
  where.code = {
    contains: search.trim()
  }
}

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [accounts, total] = await Promise.all([
      prisma.mysteryBoxAccount.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          code: true,
          rarity: true,
          // KHÔNG trả về gameUsername, gamePassword, gameBindInfo
          category: {
            select: {
              id: true,
              name: true,
              thumbnail: true,
              price: true,
              rarity: true
            }
          }
        }
      }),
      prisma.mysteryBoxAccount.count({ where })
    ])

    res.json({
      success: true,
      data: {
        category,
        accounts,
        pagination: {
          page: parseInt(page),
          limit: take,
          total,
          pages: Math.ceil(total / take)
        }
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// GET /mystery-box/accounts/:id — detail page (không reveal login)
const getAccountDetail = async (req, res) => {
  try {
    const account = await prisma.mysteryBoxAccount.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        code: true,
        rarity: true,
        isSold: true,
        // KHÔNG trả về gameUsername, gamePassword, gameBindInfo
        category: {
          select: {
            id: true,
            name: true,
            slug: true,
            thumbnail: true,
            bannerImage: true,
            detailImage: true,
            price: true,
            rarity: true,
            description: true
          }
        }
      }
    })
    if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy account' })

    res.json({ success: true, data: account })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// GET /mystery-box/categories/:id/recent-history — lịch sử mua gần đây của category (public)
const getCategoryRecentHistory = async (req, res) => {
  try {
    const { id } = req.params
    const histories = await prisma.mysteryBoxOpenHistory.findMany({
      where: { categoryId: id },
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { username: true, displayName: true, avatar: true } },
        account: { select: { rarity: true, code: true } }
      }
    })
    res.json({ success: true, data: histories })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// POST /mystery-box/categories/:id/open — mở túi mù (random acc hoặc acc cụ thể nếu truyền accountId)
const openMysteryBox = async (req, res) => {
  try {
    const { id: categoryId } = req.params
    const userId = req.user.id
    const { accountId } = req.body // optional — nếu có thì mua đúng acc này

    const category = await prisma.mysteryBoxCategory.findUnique({
      where: { id: categoryId, isActive: true }
    })
    if (!category) return res.status(404).json({ success: false, message: 'Category không tồn tại hoặc đã tắt' })

    const user = await prisma.user.findUnique({ where: { id: userId } })
    const price = parseFloat(category.price)
    if (parseFloat(user.balance) < price) {
      return res.status(400).json({
        success: false,
        message: 'Số dư không đủ',
        required: price,
        current: user.balance
      })
    }

    let selectedAccount

    if (accountId) {
      // Mua acc cụ thể — validate thuộc category và còn available
      selectedAccount = await prisma.mysteryBoxAccount.findFirst({
        where: { id: accountId, categoryId, isSold: false, status: 'AVAILABLE' }
      })
      if (!selectedAccount) {
        return res.status(400).json({ success: false, message: 'Acc này không còn khả dụng, vui lòng thử lại' })
      }
    } else {
      // Random như cũ
      const availableCount = await prisma.mysteryBoxAccount.count({
        where: { categoryId, isSold: false, status: 'AVAILABLE' }
      })
      if (availableCount === 0) {
        return res.status(400).json({ success: false, message: 'Túi mù này đã hết acc. Vui lòng thử loại khác!' })
      }

      const randomSkip = Math.floor(Math.random() * availableCount)
      const candidateAccounts = await prisma.mysteryBoxAccount.findMany({
        where: { categoryId, isSold: false, status: 'AVAILABLE' },
        skip: randomSkip,
        take: 1
      })
      if (!candidateAccounts.length) {
        return res.status(400).json({ success: false, message: 'Hết acc khả dụng, vui lòng thử lại' })
      }
      selectedAccount = candidateAccounts[0]
    }

    const result = await prisma.$transaction(async tx => {
      const locked = await tx.mysteryBoxAccount.updateMany({
        where: { id: selectedAccount.id, isSold: false, status: 'AVAILABLE' },
        data: { status: 'RESERVED' }
      })
      if (locked.count === 0) throw new Error('ACC_TAKEN')

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          balance: { decrement: price },
          totalSpent: { increment: price }
        }
      })

      await tx.mysteryBoxAccount.update({
        where: { id: selectedAccount.id },
        data: { status: 'SOLD', isSold: true, soldAt: new Date(), ownerId: userId }
      })

      await tx.mysteryBoxCategory.update({
        where: { id: categoryId },
        data: { soldCount: { increment: 1 } }
      })

      await tx.userOwnedAccount.create({
        data: {
          userId,
          accountId: selectedAccount.id,
          sourceType: 'MYSTERY_BOX',
          sourceId: categoryId,
          snapshotData: JSON.stringify({
            code: selectedAccount.code,
            rarity: selectedAccount.rarity,
            gameUsername: selectedAccount.gameUsername,
            gamePassword: selectedAccount.gamePassword,
            gameBindInfo: selectedAccount.gameBindInfo,
            categoryName: category.name,
            categoryThumbnail: category.thumbnail,
            pricePaid: price
          })
        }
      })

      const history = await tx.mysteryBoxOpenHistory.create({
        data: {
          userId,
          categoryId,
          accountId: selectedAccount.id,
          pricePaid: price,
          rarity: selectedAccount.rarity
        }
      })

      await tx.transaction.create({
        data: {
          userId,
          type: 'MYSTERY_BOX',
          amount: -price,
          balanceBefore: user.balance,
          balanceAfter: parseFloat(updatedUser.balance),
          description: `Mở ${category.name} → Acc ${selectedAccount.code} (${selectedAccount.rarity})`,
          referenceId: history.id
        }
      })

      await tx.notification.create({
        data: {
          userId,
          type: 'MYSTERY_BOX',
          title: '🎁 Mở túi mù thành công!',
          message: `Từ ${category.name}: Nhận được acc mã ${selectedAccount.code}`,
          data: {
            rarity: selectedAccount.rarity,
            categoryId,
            accountId: selectedAccount.id,
            code: selectedAccount.code
          }
        }
      })

      return { updatedUser, history }
    })

    if (['LEGENDARY', 'MYTHIC'].includes(selectedAccount.rarity)) {
      emitToAll('mysterybox:winner', {
        username: user.displayName || user.username,
        avatar: user.avatar,
        code: selectedAccount.code,
        rarity: selectedAccount.rarity,
        categoryName: category.name,
        timestamp: new Date()
      })
    }

    const revealedAccount = await prisma.mysteryBoxAccount.findUnique({
      where: { id: selectedAccount.id },
      select: {
        id: true,
        code: true,
        rarity: true,
        gameUsername: true,
        gamePassword: true,
        gameBindInfo: true,
        category: {
          select: { name: true, thumbnail: true, price: true }
        }
      }
    })

    res.json({
      success: true,
      message: 'Mở túi mù thành công!',
      data: {
        account: revealedAccount,
        category: { id: category.id, name: category.name, thumbnail: category.thumbnail },
        pricePaid: price,
        newBalance: result.updatedUser.balance
      }
    })
  } catch (e) {
    if (e.message === 'ACC_TAKEN') {
      return res.status(409).json({ success: false, message: 'Acc vừa bị người khác lấy mất! Vui lòng thử lại' })
    }
    console.error('openMysteryBox error:', e)
    res.status(500).json({ success: false, message: e.message })
  }
}

// GET /mystery-box/history — lịch sử mở túi mù của user
const getUserHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [histories, total] = await Promise.all([
      prisma.mysteryBoxOpenHistory.findMany({
        where: { userId: req.user.id },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          category: { select: { name: true, thumbnail: true, slug: true } },
          account: {
            select: {
              code: true,
              rarity: true
            }
          }
        }
      }),
      prisma.mysteryBoxOpenHistory.count({ where: { userId: req.user.id } })
    ])

    res.json({
      success: true,
      data: histories,
      pagination: { page: parseInt(page), limit: take, total, pages: Math.ceil(total / take) }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ── ADMIN ────────────────────────────────────────────────────────────────────

const adminGetCategories = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.max(parseInt(req.query.limit) || 6, 1)
    const skip = (page - 1) * limit

    const [categories, total] = await Promise.all([
      prisma.mysteryBoxCategory.findMany({
        skip,
        take: limit,
        orderBy: [
          { sortOrder: 'asc' },
          { createdAt: 'desc' }
        ],
        include: {
          _count: {
            select: {
              accounts: true,
              openHistories: true
            }
          }
        }
      }),
      prisma.mysteryBoxCategory.count()
    ])

    res.json({
      success: true,
      data: categories,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminCreateCategory = async (req, res) => {
  try {
    const { name, slug, description, price, rarity, isActive, sortOrder } = req.body

    const thumbnail = req.files?.thumbnail?.[0]?.path || req.body.thumbnail
    const thumbnailId = req.files?.thumbnail?.[0]?.filename
    const bannerImage = req.files?.banner?.[0]?.path || req.body.bannerImage
    const bannerImageId = req.files?.banner?.[0]?.filename
    const detailImage = req.files?.detail?.[0]?.path || req.body.detailImage
    const detailImageId = req.files?.detail?.[0]?.filename

    const category = await prisma.mysteryBoxCategory.create({
      data: {
        name,
        slug: slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        description: description || null,
        thumbnail: thumbnail || null,
        thumbnailId: thumbnailId || null,
        bannerImage: bannerImage || null,
        bannerImageId: bannerImageId || null,
        detailImage: detailImage || null,
        detailImageId: detailImageId || null,
        price: parseFloat(price),
        rarity: rarity || 'COMMON',
        isActive: isActive === 'true' || isActive === true,
        sortOrder: sortOrder ? parseInt(sortOrder) : 0
      }
    })
    res.status(201).json({ success: true, data: category })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminUpdateCategory = async (req, res) => {
  try {
    const old = await prisma.mysteryBoxCategory.findUnique({
      where: { id: req.params.id }
    })

    if (!old) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy category' })
    }

    const {
      name,
      slug,
      description,
      price,
      rarity,
      isActive,
      sortOrder
    } = req.body

    const data = {}

    if (name !== undefined) data.name = name
    if (slug !== undefined) data.slug = slug
    if (description !== undefined) data.description = description || null
    if (price !== undefined && price !== '') data.price = parseFloat(price)
    if (rarity !== undefined) data.rarity = rarity
    if (sortOrder !== undefined && sortOrder !== '') data.sortOrder = parseInt(sortOrder)
    if (isActive !== undefined) data.isActive = isActive === 'true' || isActive === true

    if (req.files?.thumbnail?.[0]) {
      data.thumbnail = req.files.thumbnail[0].path
      data.thumbnailId = req.files.thumbnail[0].filename
    }

    if (req.files?.banner?.[0]) {
      data.bannerImage = req.files.banner[0].path
      data.bannerImageId = req.files.banner[0].filename
    }

    if (req.files?.detail?.[0]) {
      data.detailImage = req.files.detail[0].path
      data.detailImageId = req.files.detail[0].filename
    }

    const category = await prisma.mysteryBoxCategory.update({
      where: { id: req.params.id },
      data
    })

    res.json({ success: true, data: category })
  } catch (e) {
    console.error('adminUpdateCategory error:', e)
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminDeleteCategory = async (req, res) => {
  try {
    const hasSold = await prisma.mysteryBoxAccount.count({
      where: { categoryId: req.params.id, isSold: true }
    })
    if (hasSold > 0) {
      return res.status(400).json({
        success: false,
        message: `Không thể xóa vì có ${hasSold} acc đã bán trong category này`
      })
    }
    await prisma.mysteryBoxCategory.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa category' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ── ADMIN ACCOUNTS ───────────────────────────────────────────────────────────

const adminGetAccounts = async (req, res) => {
  try {
    const { page = 1, limit = 10, categoryId, isSold, rarity, search } = req.query
    const where = {}
    if (categoryId && categoryId !== 'ALL') where.categoryId = categoryId
    if (isSold !== undefined && isSold !== 'ALL') where.isSold = isSold === 'true'
    if (rarity && rarity !== 'ALL') where.rarity = rarity
    if (search) {
      where.OR = [
        { code: { contains: search } },
        { gameUsername: { contains: search } }
      ]
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [accounts, total] = await Promise.all([
      prisma.mysteryBoxAccount.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          category: { select: { id: true, name: true, thumbnail: true, price: true } },
          owner: { select: { username: true, displayName: true } }
        }
      }),
      prisma.mysteryBoxAccount.count({ where })
    ])

    res.json({
      success: true,
      data: accounts,
      pagination: { page: parseInt(page), limit: take, total, pages: Math.ceil(total / take) }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminCreateAccount = async (req, res) => {
  try {
    const { categoryId, gameUsername, gamePassword, gameBindInfo, rarity, code } = req.body

    // Tự sinh mã nếu admin không nhập
    const finalCode = code?.trim() || `MB${Date.now().toString(36).toUpperCase().slice(-6)}`

    const account = await prisma.mysteryBoxAccount.create({
      data: {
        categoryId,
        code: finalCode,
        gameUsername: gameUsername || null,
        gamePassword: gamePassword || null,
        gameBindInfo: gameBindInfo || null,
        rarity: rarity || 'COMMON'
      },
      include: {
        category: { select: { name: true, thumbnail: true, price: true } }
      }
    })

    await prisma.mysteryBoxCategory.update({
      where: { id: categoryId },
      data: { totalAccounts: { increment: 1 } }
    })

    res.status(201).json({ success: true, data: account })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminUpdateAccount = async (req, res) => {
  try {
    const data = { ...req.body }
    if (data.isSold !== undefined) data.isSold = data.isSold === 'true' || data.isSold === true

    const account = await prisma.mysteryBoxAccount.update({
      where: { id: req.params.id },
      data,
      include: {
        category: { select: { name: true, thumbnail: true, price: true } }
      }
    })
    res.json({ success: true, data: account })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminDeleteAccount = async (req, res) => {
  try {
    const acc = await prisma.mysteryBoxAccount.findUnique({ where: { id: req.params.id } })
    if (!acc) return res.status(404).json({ success: false, message: 'Không tìm thấy account' })
    if (acc.isSold) return res.status(400).json({ success: false, message: 'Không thể xóa acc đã bán' })

    await prisma.mysteryBoxAccount.delete({ where: { id: req.params.id } })
    await prisma.mysteryBoxCategory.update({
      where: { id: acc.categoryId },
      data: { totalAccounts: { decrement: 1 } }
    })
    res.json({ success: true, message: 'Đã xóa account' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminBulkImportAccounts = async (req, res) => {
  try {
    const { categoryId, accounts } = req.body
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ success: false, message: 'Danh sách accounts trống' })
    }

    const category = await prisma.mysteryBoxCategory.findUnique({ where: { id: categoryId } })
    if (!category) return res.status(404).json({ success: false, message: 'Category không tồn tại' })

    const created = await prisma.mysteryBoxAccount.createMany({
      data: accounts.map((acc, idx) => ({
        categoryId,
        code: acc.code?.trim() || `MB${Date.now().toString(36).toUpperCase().slice(-4)}${String(idx).padStart(2,'0')}`,
        gameUsername: acc.gameUsername || null,
        gamePassword: acc.gamePassword || null,
        gameBindInfo: acc.gameBindInfo || null,
        rarity: acc.rarity || 'COMMON'
      }))
    })

    await prisma.mysteryBoxCategory.update({
      where: { id: categoryId },
      data: { totalAccounts: { increment: created.count } }
    })

    res.status(201).json({ success: true, message: `Import thành công ${created.count} accounts`, count: created.count })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminGetOpenHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, categoryId, rarity, search } = req.query
    const where = {}
    if (categoryId && categoryId !== 'ALL') where.categoryId = categoryId
    if (rarity && rarity !== 'ALL') where.rarity = rarity
    if (search) {
      where.user = {
        OR: [
          { username: { contains: search } },
          { displayName: { contains: search } }
        ]
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [histories, total] = await Promise.all([
      prisma.mysteryBoxOpenHistory.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { username: true, displayName: true, avatar: true } },
          category: { select: { name: true, thumbnail: true } },
          account: { select: { code: true, rarity: true } }
        }
      }),
      prisma.mysteryBoxOpenHistory.count({ where })
    ])

    res.json({
      success: true,
      data: histories,
      pagination: { page: parseInt(page), limit: take, total, pages: Math.ceil(total / take) }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminGetCategoryStats = async (req, res) => {
  try {
    const { id } = req.params
    const [category, rarityStats, recentOpenings] = await Promise.all([
      prisma.mysteryBoxCategory.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              accounts: true,
              openHistories: true
            }
          }
        }
      }),
      prisma.mysteryBoxOpenHistory.groupBy({
        by: ['rarity'],
        where: { categoryId: id },
        _count: true
      }),
      prisma.mysteryBoxOpenHistory.findMany({
        where: { categoryId: id },
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { username: true, displayName: true, avatar: true } },
          account: { select: { code: true, rarity: true } }
        }
      })
    ])

    const availableCount = await prisma.mysteryBoxAccount.count({
      where: { categoryId: id, isSold: false }
    })

    res.json({
      success: true,
      data: {
        category,
        rarityStats,
        recentOpenings,
        availableCount,
        totalRevenue: category._count.openHistories * parseFloat(category.price)
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// GET /mystery-box — top categories sort theo số lần mở (soldCount), dùng cho homepage
const getTopBoxes = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 4, 20)

    const categories = await prisma.mysteryBoxCategory.findMany({
      where: { isActive: true },
      orderBy: { soldCount: 'desc' },
      take: limit,
      include: {
        _count: {
          select: {
            accounts: { where: { isSold: false } },
          },
        },
      },
    })

    const result = categories.map(cat => ({
      ...cat,
      openCount: cat.soldCount,
      availableCount: cat._count.accounts,
      imageUrl: cat.thumbnail,
      rewards: [], // placeholder — FE hiển thị badge rarity từ field rarity
    }))

    res.json({ success: true, data: result })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

module.exports = {
  // User
  getTopBoxes,
  getCategories,
  getCategoryBySlug,
  getAccountDetail,
  getCategoryRecentHistory,
  openMysteryBox,
  getUserHistory,
  // Admin - categories
  adminGetCategories,
  adminCreateCategory,
  adminUpdateCategory,
  adminDeleteCategory,
  // Admin - accounts
  adminGetAccounts,
  adminCreateAccount,
  adminUpdateAccount,
  adminDeleteAccount,
  adminBulkImportAccounts,
  adminGetOpenHistory,
  adminGetCategoryStats
}