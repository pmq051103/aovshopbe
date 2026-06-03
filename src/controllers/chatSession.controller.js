/**
 * chatSession.controller.js
 * ─────────────────────────────────────────────────────────────────────────
 * Quản lý chat sessions: tạo, list, load messages, xóa
 * Tất cả routes đều yêu cầu user đăng nhập (protect middleware)
 * ─────────────────────────────────────────────────────────────────────────
 */
const prisma  = require('../config/prisma')
const logger  = require('../config/logger')

/* ─── LIST SESSIONS ─── GET /api/chat/sessions ──────────────────────── */
const listSessions = async (req, res) => {
  try {
    const sessions = await prisma.chatSession.findMany({
      where  : { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      take   : 50,
      select : {
        id       : true,
        title    : true,
        updatedAt: true,
        createdAt: true,
        // Lấy tin nhắn cuối cùng để preview
        messages : {
          orderBy: { createdAt: 'desc' },
          take   : 1,
          select : { role: true, content: true, createdAt: true },
        },
      },
    })

    const data = sessions.map(s => ({
      id         : s.id,
      title      : s.title || 'Cuộc trò chuyện mới',
      updatedAt  : s.updatedAt,
      createdAt  : s.createdAt,
      lastMessage: s.messages[0] || null,
    }))

    return res.json({ success: true, data })
  } catch (err) {
    logger.error('[ChatSession] listSessions:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ─── CREATE SESSION ─── POST /api/chat/session ─────────────────────── */
const createSession = async (req, res) => {
  try {
    const session = await prisma.chatSession.create({
      data: { userId: req.user.id, title: null },
    })
    return res.status(201).json({ success: true, data: session })
  } catch (err) {
    logger.error('[ChatSession] createSession:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ─── GET SESSION MESSAGES ─── GET /api/chat/session/:id ────────────── */
const getSession = async (req, res) => {
  try {
    const session = await prisma.chatSession.findFirst({
      where  : { id: req.params.id, userId: req.user.id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          select : {
            id       : true,
            role     : true,
            content  : true,
            metadata : true,
            createdAt: true,
          },
        },
      },
    })

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session không tồn tại' })
    }

    return res.json({ success: true, data: session })
  } catch (err) {
    logger.error('[ChatSession] getSession:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ─── DELETE SESSION ─── DELETE /api/chat/session/:id ───────────────── */
const deleteSession = async (req, res) => {
  try {
    const session = await prisma.chatSession.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    })
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session không tồn tại' })
    }
    // onDelete: Cascade → messages tự động bị xóa
    await prisma.chatSession.delete({ where: { id: req.params.id } })
    return res.json({ success: true, message: 'Đã xóa cuộc trò chuyện' })
  } catch (err) {
    logger.error('[ChatSession] deleteSession:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

/* ─── UPDATE TITLE ─── PATCH /api/chat/session/:id/title ────────────── */
const updateTitle = async (req, res) => {
  try {
    const { title } = req.body
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'title trống' })

    const session = await prisma.chatSession.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    })
    if (!session) return res.status(404).json({ success: false, message: 'Không tìm thấy' })

    const updated = await prisma.chatSession.update({
      where: { id: req.params.id },
      data : { title: title.trim() },
    })
    return res.json({ success: true, data: updated })
  } catch (err) {
    logger.error('[ChatSession] updateTitle:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server' })
  }
}

module.exports = { listSessions, createSession, getSession, deleteSession, updateTitle }
