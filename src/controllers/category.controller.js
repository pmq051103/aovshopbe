const { deleteImage } = require('../config/cloudinary')
const prisma = require('../config/prisma')

const slugify = (text) => text.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')

// ── PUBLIC ──────────────────────────────────────────────────
const getCategories = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.max(parseInt(req.query.limit) || 12, 1)
    const skip = (page - 1) * limit

    const where = { isActive: true }

    const [cats, total] = await Promise.all([
      prisma.accountCategory.findMany({
        where,
        orderBy: { sortOrder: 'asc' },
        skip,
        take: limit,

        include: {
          accounts: {
            include: {
              account: {
                select: {
                  id: true,
                  price: true,
                  status: true
                }
              }
            }
          },

          _count: {
            select: {
              accounts: true
            }
          }
        }
      }),

      prisma.accountCategory.count({ where })
    ])

    const result = cats.map(cat => {
      const availableAccounts = cat.accounts.filter(
        a => a.account?.status === 'AVAILABLE'
      )

      const prices = availableAccounts
        .map(a => Number(a.account?.price || 0))
        .filter(v => v > 0)

      return {
        ...cat,

        availableCount: availableAccounts.length,

        minPrice: prices.length
          ? Math.min(...prices)
          : null,

        maxPrice: prices.length
          ? Math.max(...prices)
          : null
      }
    })

    res.json({
      success: true,
      data: result,

      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const getCategoryBySlug = async (req, res) => {
  try {
    const cat = await prisma.accountCategory.findUnique({
      where: { slug: req.params.slug },
      include: { _count: { select: { accounts: true } } },
    })
    if (!cat) return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục' })
    res.json({ success: true, data: cat })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN CRUD ───────────────────────────────────────────────
const adminGetCategories = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.max(parseInt(req.query.limit) || 6, 1)
    const skip = (page - 1) * limit

    const [total, cats] = await Promise.all([
      prisma.accountCategory.count(),
      prisma.accountCategory.findMany({
        orderBy: [
          { sortOrder: 'asc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: limit,
        include: {
          _count: {
            select: { accounts: true },
          },
        },
      }),
    ])

    res.json({
      success: true,
      data: cats,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message,
    })
  }
}

const adminCreateCategory = async (req, res) => {
  try {
    const { name, description, icon, sortOrder, isActive } = req.body
    const slug = slugify(name)
    const existing = await prisma.accountCategory.findUnique({ where: { slug } })
    if (existing) return res.status(409).json({ success: false, message: 'Slug đã tồn tại' })

    const cat = await prisma.accountCategory.create({
      data: {
        name, slug, description, icon,
        imageUrl: req.file?.path || req.body.imageUrl,
        imagePublicId: req.file?.filename,
        sortOrder: parseInt(sortOrder || 0),
        isActive: isActive === 'true' || isActive === true,
      },
    })
    res.status(201).json({ success: true, data: cat })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminUpdateCategory = async (req, res) => {
  try {
    const data = { ...req.body }

    if (req.file) {
      // Xoa anh cu tren Cloudinary neu co
      const old = await prisma.accountCategory.findUnique({ where: { id: req.params.id }, select: { imagePublicId: true } })
      if (old?.imagePublicId) await deleteImage(old.imagePublicId)

      data.imageUrl = req.file.path
      data.imagePublicId = req.file.filename
    } else {
      // Khong upload file moi -> khong cho ghi de imagePublicId / imageUrl tu body
      delete data.imagePublicId
      delete data.imageUrl
    }

    if (data.sortOrder !== undefined) data.sortOrder = parseInt(data.sortOrder)
    if (data.isActive !== undefined) data.isActive = data.isActive === 'true' || data.isActive === true
    if (data.name) data.slug = slugify(data.name)

    const cat = await prisma.accountCategory.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: cat })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminDeleteCategory = async (req, res) => {
  try {
    const cat = await prisma.accountCategory.findUnique({ where: { id: req.params.id } })
    if (cat?.imagePublicId) await deleteImage(cat.imagePublicId)
    await prisma.accountCategory.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa danh mục' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Set categories for an account ───────────────────────────
const setAccountCategories = async (req, res) => {
  try {
    const { accountId, categoryIds } = req.body // categoryIds: string[]
    if (!Array.isArray(categoryIds)) return res.status(400).json({ success: false, message: 'categoryIds phải là array' })

    // Delete old relations
    await prisma.accountCategoryRelation.deleteMany({ where: { accountId } })

    // Create new ones
    if (categoryIds.length > 0) {
      await prisma.accountCategoryRelation.createMany({
        data: categoryIds.map(categoryId => ({ accountId, categoryId })),
        skipDuplicates: true,
      })
    }
    res.json({ success: true, message: 'Đã cập nhật danh mục tài khoản' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}



module.exports = { getCategories, getCategoryBySlug, adminGetCategories, adminCreateCategory, adminUpdateCategory, adminDeleteCategory, setAccountCategories }