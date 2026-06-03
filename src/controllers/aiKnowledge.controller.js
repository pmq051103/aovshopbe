/**
 * aiKnowledge.controller.js
 * ─────────────────────────────────────────────────────────────────────────
 * CRUD quản lý AiKnowledge (admin) + API đồng bộ sang Pinecone
 *
 * Luồng dữ liệu:
 *  Admin thêm/sửa/xóa → MySQL (Prisma)
 *                 ↓ (admin bấm "Đồng bộ AI")
 *  syncToVector → lấy active records → Gemini Embedding → Pinecone upsert
 *                 ↓ (khi chatbot nhận câu hỏi)
 *  chatbot.controller → searchSimilar → build context → Gemini chat
 * ─────────────────────────────────────────────────────────────────────────
 */

const prisma = require('../config/prisma')
const logger = require('../config/logger')
const { upsertKnowledgeVectors, deleteVectors, getIndexStats } = require('../services/pinecone.service')

const PAGE_LIMIT = 10

/* ═══════════════════════════════════════════════════════════
   LIST — GET /api/admin/ai-knowledge
   Query: page, limit, type, isActive, search
   ═══════════════════════════════════════════════════════════ */
const list = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1)
    const limit  = Math.min(100, parseInt(req.query.limit) || PAGE_LIMIT)
    const skip   = (page - 1) * limit
    const { type, isActive, search } = req.query

    const where = {}

    if (type)   where.type     = type
    if (isActive !== undefined) where.isActive = isActive === 'true'
    if (search) {
      where.OR = [
        { title  : { contains: search } },
        { content: { contains: search } },
      ]
    }

    const [items, total] = await Promise.all([
      prisma.aiKnowledge.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id       : true,
          title    : true,
          type     : true,
          isActive : true,
          vectorId : true,
          syncedAt : true,
          createdAt: true,
          updatedAt: true,
          // Không trả content trong list để giảm payload
        },
      }),
      prisma.aiKnowledge.count({ where }),
    ])

    return res.json({
      success: true,
      data   : items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (err) {
    logger.error('[AiKnowledge] list error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ═══════════════════════════════════════════════════════════
   GET ONE — GET /api/admin/ai-knowledge/:id
   ═══════════════════════════════════════════════════════════ */
const getOne = async (req, res) => {
  try {
    const item = await prisma.aiKnowledge.findUnique({
      where: { id: req.params.id },
    })

    if (!item) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    return res.json({ success: true, data: item })
  } catch (err) {
    logger.error('[AiKnowledge] getOne error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ═══════════════════════════════════════════════════════════
   CREATE — POST /api/admin/ai-knowledge
   Body: { title, type, content, isActive? }
   ═══════════════════════════════════════════════════════════ */
const create = async (req, res) => {
  try {
    const { title, type, content, isActive = true } = req.body

    if (!title?.trim())   return res.status(400).json({ success: false, message: 'title là bắt buộc' })
    if (!type)            return res.status(400).json({ success: false, message: 'type là bắt buộc' })
    if (!content?.trim()) return res.status(400).json({ success: false, message: 'content là bắt buộc' })

    const VALID_TYPES = ['FAQ', 'POLICY', 'GUIDE', 'TERM']
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: `type phải là: ${VALID_TYPES.join(', ')}` })
    }

    const item = await prisma.aiKnowledge.create({
      data: {
        title   : title.trim(),
        type,
        content : content.trim(),
        isActive,
        // vectorId và syncedAt sẽ được set sau khi sync
      },
    })

    logger.info(`[AiKnowledge] Created: ${item.id} - ${item.title}`)

    return res.status(201).json({
      success: true,
      data   : item,
      message: 'Tạo thành công. Nhớ bấm "Đồng bộ AI" để cập nhật lên Pinecone.',
    })
  } catch (err) {
    logger.error('[AiKnowledge] create error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ═══════════════════════════════════════════════════════════
   UPDATE — PUT /api/admin/ai-knowledge/:id
   Body: { title?, type?, content?, isActive? }
   ═══════════════════════════════════════════════════════════ */
const update = async (req, res) => {
  try {
    const { id } = req.params
    const { title, type, content, isActive } = req.body

    const existing = await prisma.aiKnowledge.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    if (type) {
      const VALID_TYPES = ['FAQ', 'POLICY', 'GUIDE', 'TERM']
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: `type phải là: ${VALID_TYPES.join(', ')}` })
      }
    }

    const updateData = {}
    if (title   !== undefined) updateData.title    = title.trim()
    if (type    !== undefined) updateData.type     = type
    if (content !== undefined) updateData.content  = content.trim()
    if (isActive !== undefined) updateData.isActive = isActive

    // Khi sửa nội dung, reset syncedAt để admin biết cần sync lại
    if (title !== undefined || content !== undefined || isActive !== undefined) {
      updateData.syncedAt = null
    }

    const updated = await prisma.aiKnowledge.update({
      where: { id },
      data : updateData,
    })

    return res.json({
      success: true,
      data   : updated,
      message: 'Cập nhật thành công. Nhớ bấm "Đồng bộ AI" để sync lên Pinecone.',
    })
  } catch (err) {
    logger.error('[AiKnowledge] update error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ═══════════════════════════════════════════════════════════
   DELETE — DELETE /api/admin/ai-knowledge/:id
   Xóa khỏi MySQL + xóa vector khỏi Pinecone nếu đã sync
   ═══════════════════════════════════════════════════════════ */
const remove = async (req, res) => {
  try {
    const { id } = req.params
    const existing = await prisma.aiKnowledge.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    // Xóa vector trên Pinecone nếu đã từng được sync (vectorId != null)
    if (existing.vectorId) {
      try {
        await deleteVectors([existing.vectorId])
      } catch (pineconeErr) {
        // Không block việc xóa record nếu Pinecone lỗi
        logger.warn(`[AiKnowledge] Xóa Pinecone vector thất bại (vẫn xóa MySQL): ${pineconeErr.message}`)
      }
    }

    await prisma.aiKnowledge.delete({ where: { id } })

    logger.info(`[AiKnowledge] Deleted: ${id} - ${existing.title}`)
    return res.json({ success: true, message: 'Đã xóa thành công' })
  } catch (err) {
    logger.error('[AiKnowledge] delete error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ═══════════════════════════════════════════════════════════
   SYNC TO VECTOR DB — POST /api/admin/ai-knowledge/sync
   ─────────────────────────────────────────────────────────
   Lấy toàn bộ active records từ MySQL → tạo embedding → upsert Pinecone
   Sau đó update vectorId + syncedAt trong MySQL
   ═══════════════════════════════════════════════════════════ */
const syncToVector = async (req, res) => {
  try {
    logger.info('[AiKnowledge] Bắt đầu đồng bộ sang Pinecone...')

    // 1. Lấy toàn bộ active records
    const records = await prisma.aiKnowledge.findMany({
      where  : { isActive: true },
      orderBy: { updatedAt: 'asc' },
      select : { id: true, title: true, type: true, content: true },
    })

    if (records.length === 0) {
      return res.json({
        success: true,
        message: 'Không có dữ liệu active để đồng bộ',
        stats  : { total: 0, success: 0, failed: 0 },
      })
    }

    logger.info(`[AiKnowledge] Sync ${records.length} records...`)

    // 2. Upsert lên Pinecone (tạo embedding + upsert từng record)
    const result = await upsertKnowledgeVectors(records)

    // 3. Với các record upsert thành công → update vectorId + syncedAt trong MySQL
    //    Dùng vectorId = id của chính record để 1-1 mapping
    const successIds = records
      .filter(r => !result.errors.some(e => e.includes(r.id)))
      .map(r => r.id)

    if (successIds.length > 0) {
      const now = new Date()

      // Update vectorId từng record (vectorId = id của chính record đó)
      await Promise.all(
        successIds.map(id =>
          prisma.aiKnowledge.update({
            where: { id },
            data : { vectorId: id, syncedAt: now },
          })
        )
      )
    }

    logger.info(`[AiKnowledge] Sync xong: ${result.success} OK, ${result.failed} lỗi`)

    return res.json({
      success: true,
      message: `Đồng bộ hoàn tất: ${result.success}/${records.length} thành công`,
      stats  : {
        total  : records.length,
        success: result.success,
        failed : result.failed,
        errors : result.errors,
      },
    })
  } catch (err) {
    logger.error('[AiKnowledge] syncToVector error:', err)
    return res.status(500).json({ success: false, message: `Lỗi sync: ${err.message}` })
  }
}

/* ═══════════════════════════════════════════════════════════
   SYNC STATUS — GET /api/admin/ai-knowledge/sync-status
   Trả về thông tin trạng thái sync + thống kê Pinecone index
   ═══════════════════════════════════════════════════════════ */
const getSyncStatus = async (req, res) => {
  try {
    const [total, active, synced, unsynced] = await Promise.all([
      prisma.aiKnowledge.count(),
      prisma.aiKnowledge.count({ where: { isActive: true } }),
      prisma.aiKnowledge.count({ where: { isActive: true, syncedAt: { not: null } } }),
      prisma.aiKnowledge.count({ where: { isActive: true, syncedAt: null } }),
    ])

    // Lấy thời điểm sync gần nhất
    const lastSynced = await prisma.aiKnowledge.findFirst({
      where  : { syncedAt: { not: null } },
      orderBy: { syncedAt: 'desc' },
      select : { syncedAt: true },
    })

    // Lấy thống kê index từ Pinecone
    let pineconeStats = null
    try {
      pineconeStats = await getIndexStats()
    } catch (err) {
      logger.warn('[AiKnowledge] Không lấy được Pinecone stats:', err.message)
    }

    return res.json({
      success: true,
      data   : {
        mysql: { total, active, synced, unsynced },
        lastSyncedAt: lastSynced?.syncedAt || null,
        pinecone    : pineconeStats
          ? {
              totalVectors    : pineconeStats.totalRecordCount || 0,
              indexFullness   : pineconeStats.indexFullness    || 0,
            }
          : null,
      },
    })
  } catch (err) {
    logger.error('[AiKnowledge] getSyncStatus error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ═══════════════════════════════════════════════════════════
   TOGGLE ACTIVE — PATCH /api/admin/ai-knowledge/:id/toggle
   ═══════════════════════════════════════════════════════════ */
const toggleActive = async (req, res) => {
  try {
    const { id } = req.params
    const existing = await prisma.aiKnowledge.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    const updated = await prisma.aiKnowledge.update({
      where: { id },
      data : {
        isActive: !existing.isActive,
        syncedAt: null, // Reset để admin biết cần sync lại
      },
    })

    return res.json({
      success: true,
      data   : updated,
      message: `Đã ${updated.isActive ? 'kích hoạt' : 'ẩn'}. Nhớ đồng bộ AI lại.`,
    })
  } catch (err) {
    logger.error('[AiKnowledge] toggleActive error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

module.exports = { list, getOne, create, update, remove, syncToVector, getSyncStatus, toggleActive }
