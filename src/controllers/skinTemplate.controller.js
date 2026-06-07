/**
 * skinTemplate.controller.js
 * ─────────────────────────────────────────────────────────────────────────
 * CRUD SkinTemplate (admin seed dữ liệu cho AI)
 * + Detect skin từ ảnh account
 *
 * Không dùng Pinecone — chỉ Gemini Vision + MySQL fuzzy match
 * ─────────────────────────────────────────────────────────────────────────
 */

const prisma  = require('../config/prisma')
const logger  = require('../config/logger')
const { deleteImage } = require('../config/cloudinary')
const { detectSkinsFromImage, verifySkinImage } = require('../services/skinDetect.service')

/* ══════════════════════════════════════════════════════════
   LIST  GET /api/skin-templates
   ══════════════════════════════════════════════════════════ */
const list = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1)
    const limit  = Math.min(100, parseInt(req.query.limit) || 20)
    const skip   = (page - 1) * limit
    const { search, heroName, rarity } = req.query

    const where = { isActive: true }
    if (heroName) where.heroName = { contains: heroName }
    if (rarity)   where.rarity   = rarity
    if (search) {
      where.OR = [
        { skinName: { contains: search } },
        { heroName: { contains: search } },
        { aliases:  { contains: search } },
      ]
    }

    const [items, total] = await Promise.all([
      prisma.skinTemplate.findMany({ where, orderBy: { heroName: 'asc' }, skip, take: limit }),
      prisma.skinTemplate.count({ where }),
    ])

    res.json({
      success: true,
      data: items,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    })
  } catch (err) {
    logger.error(`[SkinTemplate.list] ${err.message}`)
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ══════════════════════════════════════════════════════════
   CREATE  POST /api/skin-templates
   ══════════════════════════════════════════════════════════ */
const create = async (req, res) => {
  try {
    const { skinName, heroName, rarity = 'COMMON', aliases } = req.body

    if (!skinName?.trim()) return res.status(400).json({ success: false, message: 'skinName là bắt buộc' })
    if (!heroName?.trim()) return res.status(400).json({ success: false, message: 'heroName là bắt buộc' })

    const existing = await prisma.skinTemplate.findFirst({
      where: { skinName: skinName.trim() },
    })
    if (existing) return res.status(409).json({ success: false, message: `Skin "${skinName}" đã tồn tại` })

    const imageUrl      = req.file?.path     || null
    const imagePublicId = req.file?.filename || null

    // Nếu có ảnh → dùng Gemini verify ảnh có đúng là skin này không
    let verifyResult = null
    if (imageUrl) {
      try {
        verifyResult = await verifySkinImage(imageUrl, skinName.trim())
        if (!verifyResult.isMatch && verifyResult.confidence < 0.4) {
          logger.warn(`[SkinTemplate.create] Ảnh có thể không khớp: ${verifyResult.detectedSkin} vs ${skinName}`)
        }
      } catch (e) {
        logger.warn(`[SkinTemplate.create] Verify ảnh lỗi (bỏ qua): ${e.message}`)
      }
    }

    const template = await prisma.skinTemplate.create({
      data: {
        skinName:     skinName.trim(),
        heroName:     heroName.trim(),
        rarity,
        aliases:      aliases?.trim() || null,
        imageUrl,
        imagePublicId,
      },
    })

    res.status(201).json({
      success: true,
      data: template,
      verifyResult,
      message: 'Tạo skin template thành công',
    })
  } catch (err) {
    logger.error(`[SkinTemplate.create] ${err.message}`)
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ══════════════════════════════════════════════════════════
   UPDATE  PUT /api/skin-templates/:id
   ══════════════════════════════════════════════════════════ */
const update = async (req, res) => {
  try {
    const { id } = req.params
    const { skinName, heroName, rarity, aliases, isActive } = req.body

    const existing = await prisma.skinTemplate.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    let imageUrl      = existing.imageUrl
    let imagePublicId = existing.imagePublicId
    if (req.file) {
      if (existing.imagePublicId) await deleteImage(existing.imagePublicId)
      imageUrl      = req.file.path
      imagePublicId = req.file.filename
    }

    const updated = await prisma.skinTemplate.update({
      where: { id },
      data: {
        ...(skinName !== undefined && { skinName: skinName.trim() }),
        ...(heroName !== undefined && { heroName: heroName.trim() }),
        ...(rarity   !== undefined && { rarity }),
        ...(aliases  !== undefined && { aliases: aliases?.trim() || null }),
        ...(isActive !== undefined && { isActive: isActive === 'true' || isActive === true }),
        imageUrl,
        imagePublicId,
      },
    })

    res.json({ success: true, data: updated, message: 'Cập nhật thành công' })
  } catch (err) {
    logger.error(`[SkinTemplate.update] ${err.message}`)
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ══════════════════════════════════════════════════════════
   DELETE  DELETE /api/skin-templates/:id
   ══════════════════════════════════════════════════════════ */
const remove = async (req, res) => {
  try {
    const { id } = req.params
    const existing = await prisma.skinTemplate.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    if (existing.imagePublicId) await deleteImage(existing.imagePublicId)
    await prisma.skinTemplate.delete({ where: { id } })

    res.json({ success: true, message: 'Đã xóa skin template' })
  } catch (err) {
    logger.error(`[SkinTemplate.delete] ${err.message}`)
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ══════════════════════════════════════════════════════════
   DETECT  POST /api/skin-templates/detect/:accountId
   Gemini Vision nhận diện skin từ ảnh, match với DB
   Body: { imageUrl? }  — nếu không truyền → dùng ảnh đầu của account
   ══════════════════════════════════════════════════════════ */
const detectSkins = async (req, res) => {
  try {
    const { accountId } = req.params
    let { imageUrl } = req.body

    if (!imageUrl) {
      const account = await prisma.gameAccount.findUnique({
        where: { id: accountId },
        include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } },
      })
      if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy account' })
      imageUrl = account.images?.[0]?.url || account.thumbnailUrl
    }

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'Không có ảnh để phân tích. Truyền imageUrl hoặc upload ảnh cho account trước.',
      })
    }

    logger.info(`[SkinDetect] accountId=${accountId}`)
    const detected = await detectSkinsFromImage(imageUrl)

    res.json({
      success: true,
      data: detected,
      total: detected.length,
      matched: detected.filter(s => s.isMatched).length,
      unmatched: detected.filter(s => !s.isMatched).length,
      imageUrl,
      message: detected.length
        ? `Nhận diện được ${detected.length} skin (${detected.filter(s => s.isMatched).length} khớp DB)`
        : 'Không nhận diện được skin nào',
    })
  } catch (err) {
    logger.error(`[SkinTemplate.detectSkins] ${err.message}`)
    res.status(500).json({ success: false, message: `Lỗi AI detect: ${err.message}` })
  }
}

/* ══════════════════════════════════════════════════════════
   CONFIRM  POST /api/skin-templates/confirm/:accountId
   Admin tick chọn xong → lưu vào AccountSkin
   Body: { skins: [{ skinName, heroName, confidence, templateId, rarity }] }
   ══════════════════════════════════════════════════════════ */
const confirmSkins = async (req, res) => {
  try {
    const { accountId } = req.params
    const { skins = [] } = req.body

    if (!skins.length) return res.status(400).json({ success: false, message: 'Danh sách skin trống' })

    const account = await prisma.gameAccount.findUnique({ where: { id: accountId } })
    if (!account) return res.status(404).json({ success: false, message: 'Không tìm thấy account' })

    // Xóa skin AI cũ, giữ MANUAL
    await prisma.accountSkin.deleteMany({ where: { accountId, detectedBy: 'AI' } })

    await prisma.accountSkin.createMany({
      data: skins.map(s => ({
        accountId,
        skinName:    s.skinName,
        heroName:    s.heroName  || null,
        tier:        s.rarity    || null,
        detectedBy:  'AI',
        confidence:  s.confidence || null,
        isConfirmed: true,
        templateId:  s.templateId || null,
      })),
    })

    // Cập nhật tổng số skin
    const totalSkins = await prisma.accountSkin.count({ where: { accountId } })
    await prisma.gameAccount.update({ where: { id: accountId }, data: { skins: totalSkins } })

    res.json({ success: true, message: `Đã lưu ${skins.length} skin`, saved: skins.length })
  } catch (err) {
    logger.error(`[SkinTemplate.confirmSkins] ${err.message}`)
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ══════════════════════════════════════════════════════════
   GET HEROES  GET /api/skin-templates/heroes
   ══════════════════════════════════════════════════════════ */
const getHeroes = async (req, res) => {
  try {
    const heroes = await prisma.skinTemplate.findMany({
      where: { isActive: true },
      select: { heroName: true },
      distinct: ['heroName'],
      orderBy: { heroName: 'asc' },
    })
    res.json({ success: true, data: heroes.map(h => h.heroName) })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ══════════════════════════════════════════════════════════
   STATS  GET /api/skin-templates/stats
   ══════════════════════════════════════════════════════════ */
const getStats = async (req, res) => {
  try {
    const [total, byRarity, byHero] = await Promise.all([
      prisma.skinTemplate.count({ where: { isActive: true } }),
      prisma.skinTemplate.groupBy({ by: ['rarity'], where: { isActive: true }, _count: true }),
      prisma.skinTemplate.groupBy({ by: ['heroName'], where: { isActive: true }, _count: true, orderBy: { _count: { heroName: 'desc' } }, take: 10 }),
    ])
    res.json({ success: true, data: { total, byRarity, topHeroes: byHero } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi server' })
  }     
}

module.exports = { list, create, update, remove, detectSkins, confirmSkins, getHeroes, getStats }