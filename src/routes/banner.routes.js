const express = require('express')
const router = express.Router()
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBanner, deleteImage } = require('../config/cloudinary')

const prisma = require('../config/prisma')
const formatBannerData = (body, file) => {
  const data = {}

  if (body.title !== undefined) data.title = body.title
  if (body.subtitle !== undefined) data.subtitle = body.subtitle
  if (body.linkUrl !== undefined) data.linkUrl = body.linkUrl
  if (body.linkText !== undefined) data.linkText = body.linkText

  if (body.sortOrder !== undefined) {
    data.sortOrder = parseInt(body.sortOrder) || 0
  }

  if (body.isActive !== undefined) {
    data.isActive = body.isActive === true || body.isActive === 'true'
  }

  if (file) {
    const isVideo = file.mimetype.startsWith('video/')
    data.mediaType = isVideo ? 'video' : 'image'
    data.imageUrl = file.path      // Cloudinary trả về URL cho cả ảnh lẫn video
    data.imagePublicId = file.filename
  } else if (body.imageUrl) {
    data.imageUrl = body.imageUrl
  }

  if (body.startDate !== undefined) {
    data.startDate = body.startDate ? new Date(body.startDate) : null
  }

  if (body.endDate !== undefined) {
    data.endDate = body.endDate ? new Date(body.endDate) : null
  }

  return data
}

router.get('/', async (req, res) => {
  try {
    const now = new Date()

    const banners = await prisma.banner.findMany({
      where: {
        isActive: true,
        AND: [
          {
            OR: [
              { startDate: null },
              { startDate: { lte: now } }
            ]
          },
          {
            OR: [
              { endDate: null },
              { endDate: { gte: now } }
            ]
          }
        ]
      },
      orderBy: { sortOrder: 'asc' }
    })

    res.json({ success: true, data: banners })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
})

router.get('/admin', protect, adminOnly, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.max(parseInt(req.query.limit) || 6, 1)
    const skip = (page - 1) * limit

    const [total, banners] = await Promise.all([
      prisma.banner.count(),
      prisma.banner.findMany({
        orderBy: [
          { sortOrder: 'asc' },
          { createdAt: 'desc' }
        ],
        skip,
        take: limit
      })
    ])

    res.json({
      success: true,
      data: banners,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
})

router.post('/', protect, adminOnly, uploadBanner.single('image'), async (req, res) => {
  try {
    if (!req.file && !req.body.imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng chọn ảnh banner'
      })
    }

    const data = formatBannerData(req.body, req.file)

    const banner = await prisma.banner.create({
      data
    })

    res.status(201).json({
      success: true,
      data: banner
    })
  } catch (e) {
    console.log('CREATE BANNER ERROR:', e)

    res.status(500).json({
      success: false,
      message: e.message
    })
  }
})

router.put('/:id', protect, adminOnly, uploadBanner.single('image'), async (req, res) => {
  try {
    const oldBanner = await prisma.banner.findUnique({
      where: { id: req.params.id }
    })

    if (!oldBanner) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy banner'
      })
    }

    if (req.file && oldBanner.imagePublicId) {
      await deleteImage(oldBanner.imagePublicId, oldBanner.mediaType)
    }

    const data = formatBannerData(req.body, req.file)

    const banner = await prisma.banner.update({
      where: { id: req.params.id },
      data
    })

    res.json({
      success: true,
      data: banner
    })
  } catch (e) {
    console.log('UPDATE BANNER ERROR:', e)

    res.status(500).json({
      success: false,
      message: e.message
    })
  }
})

router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const banner = await prisma.banner.findUnique({
      where: { id: req.params.id }
    })

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy banner'
      })
    }

    if (banner.imagePublicId) {
      await deleteImage(banner.imagePublicId, banner.mediaType)
    }

    await prisma.banner.delete({
      where: { id: req.params.id }
    })

    res.json({
      success: true,
      message: 'Xóa banner thành công'
    })
  } catch (e) {
    console.log('DELETE BANNER ERROR:', e)

    res.status(500).json({
      success: false,
      message: e.message
    })
  }
})

module.exports = router