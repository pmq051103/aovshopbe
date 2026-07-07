const express = require('express')
const router = express.Router()
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBanner, deleteImage } = require('../config/cloudinary')
const { sanitizeRichText } = require('../utils/sanitizeRichText')

const prisma = require('../config/prisma')

// GET /api/news - public, lấy danh sách tin đã published
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 9, tag } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = { isPublished: true }
    if (tag) where.tags = { contains: tag }

    const [news, total] = await Promise.all([
      prisma.news.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take: parseInt(limit),
        select: { id: true, title: true, slug: true, summary: true, thumbnailUrl: true, tags: true, viewCount: true, publishedAt: true, createdAt: true }
      }),
      prisma.news.count({ where })
    ])

    res.json({ success: true, data: news, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

// GET /api/news/:slug - public, xem chi tiết + tăng view
router.get('/:slug', async (req, res) => {
  try {
    const news = await prisma.news.findFirst({ where: { slug: req.params.slug, isPublished: true } })
    if (!news) return res.status(404).json({ success: false, message: 'Không tìm thấy tin tức' })

    const updated = await prisma.news.update({ where: { id: news.id }, data: { viewCount: { increment: 1 } } })

    res.json({ success: true, data: updated })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

// Admin: GET all (bao gồm draft)
router.get('/admin/all', protect, adminOnly, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const limit = Math.max(parseInt(req.query.limit) || 10, 1)
    const search = (req.query.search || '').trim()

    const skip = (page - 1) * limit

    const where = search
      ? {
          OR: [
            { title: { contains: search } },
            { summary: { contains: search } },
            { tags: { contains: search } },
          ],
        }
      : {}

    const [news, total] = await Promise.all([
      prisma.news.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.news.count({ where }),
    ])

    res.json({
      success: true,
      data: news,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// Admin: POST tạo tin
router.post('/', protect, adminOnly, uploadBanner.single('thumbnail'), async (req, res) => {
  try {
    const { title, summary, content, tags, isPublished } = req.body
    if (!title || !content) return res.status(400).json({ success: false, message: 'Tiêu đề và nội dung không được trống' })

    const slug = title.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim()
      + '-' + Date.now()

    const news = await prisma.news.create({
      data: {
        title,
        slug,
        summary: summary || '',
        content: sanitizeRichText(content),
        tags: tags || '',
        thumbnailUrl: req.file?.path || req.body.thumbnailUrl || null,
        thumbnailId: req.file?.filename || null,
        isPublished: isPublished === 'true' || isPublished === true,
        publishedAt: (isPublished === 'true' || isPublished === true) ? new Date() : null,
      }
    })

    res.status(201).json({ success: true, data: news })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

// Admin: PUT cập nhật
router.put('/:id', protect, adminOnly, uploadBanner.single('thumbnail'), async (req, res) => {
  try {
    const old = await prisma.news.findUnique({ where: { id: req.params.id } })
    if (!old) return res.status(404).json({ success: false, message: 'Không tìm thấy tin tức' })

    if (req.file && old.thumbnailId) await deleteImage(old.thumbnailId)

    const { title, summary, content, tags, isPublished } = req.body
    const pub = isPublished === 'true' || isPublished === true

    const news = await prisma.news.update({
      where: { id: req.params.id },
      data: {
        ...(title && { title }),
        ...(summary !== undefined && { summary }),
        ...(content && { content: sanitizeRichText(content) }),
        ...(tags !== undefined && { tags }),
        ...(req.file && { thumbnailUrl: req.file.path, thumbnailId: req.file.filename }),
        ...(!req.file && req.body.thumbnailUrl !== undefined && { thumbnailUrl: req.body.thumbnailUrl }),
        isPublished: pub,
        publishedAt: pub && !old.publishedAt ? new Date() : old.publishedAt,
      }
    })

    res.json({ success: true, data: news })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

// Admin: DELETE
router.delete('/:id', protect, adminOnly, async (req, res) => {
  try {
    const news = await prisma.news.findUnique({ where: { id: req.params.id } })
    if (!news) return res.status(404).json({ success: false, message: 'Không tìm thấy tin tức' })
    if (news.thumbnailId) await deleteImage(news.thumbnailId)
    await prisma.news.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa tin tức' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
})

module.exports = router