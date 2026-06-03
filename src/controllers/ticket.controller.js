const prisma = require('../config/prisma')

const genTicketCode = () => `TK-${Date.now().toString(36).toUpperCase()}`

const getMyUnreadCount = async (req, res) => {
  try {
    const count = await prisma.ticket.count({
      where: {
        userId: req.user.id,
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        messages: { some: { senderRole: 'ADMIN', isRead: false } }
      }
    })
    res.json({ success: true, data: { count } })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const createTicket = async (req, res) => {
  try {
    const { subject, message, category = 'general', priority = 'MEDIUM' } = req.body

    const ticket = await prisma.ticket.create({
      data: {
        ticketCode: genTicketCode(),
        userId: req.user.id,
        subject,
        category,
        priority,
        messages: {
          create: {
            senderId: req.user.id,
            senderRole: 'USER',
            message
          }
        }
      },
      include: {
        messages: true
      }
    })

    const io = req.app.get('io')

    io?.to('admins').emit('ticket:new', {
      ticketId: ticket.id,
      ticketCode: ticket.ticketCode,
      subject,
      username: req.user.username,
      priority
    })

    io?.to('admins').emit('ticket:updated')

    res.status(201).json({
      success: true,
      data: ticket
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const getMyTickets = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query

    const pageNumber = parseInt(page)
    const limitNumber = parseInt(limit)

    const where = {
      userId: req.user.id
    }

    if (status) where.status = status

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        skip: (pageNumber - 1) * limitNumber,
        take: limitNumber,
        orderBy: {
          updatedAt: 'desc'
        },
        include: {
          messages: {
            orderBy: {
              createdAt: 'desc'
            },
            take: 1
          }
        }
      }),
      prisma.ticket.count({ where })
    ])

    res.json({
      success: true,
      data: tickets,
      pagination: {
        page: pageNumber,
        total
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const getTicketDetail = async (req, res) => {
  try {
    const ticket = await prisma.ticket.findFirst({
      where:
        req.user.role === 'ADMIN'
          ? { id: req.params.id }
          : { id: req.params.id, userId: req.user.id },
      include: {
        messages: {
          orderBy: {
            createdAt: 'asc'
          }
        },
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        }
      }
    })

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy ticket'
      })
    }

    // Nếu admin xem ticket → đánh dấu tất cả tin nhắn USER là đã đọc
    if (req.user.role === 'ADMIN') {
      await prisma.ticketMessage.updateMany({
        where: { ticketId: ticket.id, senderRole: 'USER', isRead: false },
        data: { isRead: true }
      })
    }

    // Nếu user xem ticket → đánh dấu tất cả tin nhắn ADMIN là đã đọc
    if (req.user.role !== 'ADMIN') {
      await prisma.ticketMessage.updateMany({
        where: { ticketId: ticket.id, senderRole: 'ADMIN', isRead: false },
        data: { isRead: true }
      })
    }

    res.json({
      success: true,
      data: ticket
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const sendMessage = async (req, res) => {
  try {
    const { message } = req.body
    const imageUrl = req.file?.path || null

    const ticket = await prisma.ticket.findFirst({
      where:
        req.user.role === 'ADMIN'
          ? { id: req.params.id, status: { not: 'CLOSED' } }
          : { id: req.params.id, userId: req.user.id, status: { not: 'CLOSED' } }
    })

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy hoặc ticket đã đóng'
      })
    }

    const msg = await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        senderId: req.user.id,
        senderRole: req.user.role,
        message,
        imageUrl
      }
    })

    const updateData = {
      updatedAt: new Date()
    }

    if (req.user.role === 'ADMIN' && ticket.status === 'OPEN') {
      updateData.status = 'IN_PROGRESS'
    }

    await prisma.ticket.update({
      where: {
        id: ticket.id
      },
      data: updateData
    })

    const io = req.app.get('io')

    io?.to(`ticket:${ticket.id}`).emit('ticket:message', {
      ...msg,
      senderRole: req.user.role,
      senderName: req.user.displayName || req.user.username
    })

    io?.to(`ticket:${ticket.id}`).emit('ticket:updated')
    io?.to('admins').emit('ticket:updated')

    if (req.user.role === 'ADMIN') {
      io?.to(`user:${ticket.userId}`).emit('notification', {
        type: 'SYSTEM',
        title: '💬 Hỗ trợ đã phản hồi',
        message: `Ticket ${ticket.ticketCode} có tin nhắn mới`
      })
    } else {
      io?.to('admins').emit('ticket:reply', {
        ticketId: ticket.id,
        ticketCode: ticket.ticketCode
      })
    }

    res.json({
      success: true,
      data: msg
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const closeTicket = async (req, res) => {
  try {
    const where =
      req.user.role === 'ADMIN'
        ? { id: req.params.id }
        : { id: req.params.id, userId: req.user.id }

    const ticket = await prisma.ticket.update({
      where,
      data: {
        status: 'CLOSED',
        closedAt: new Date()
      }
    })

    const io = req.app.get('io')

    io?.to(`ticket:${ticket.id}`).emit('ticket:updated', ticket)
    io?.to('admins').emit('ticket:updated')
    io?.to(`user:${ticket.userId}`).emit('ticket:updated', ticket)

    res.json({
      success: true,
      message: 'Ticket đã đóng',
      data: ticket
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const resolveTicket = async (req, res) => {
  try {
    const where =
      req.user.role === 'ADMIN'
        ? { id: req.params.id }
        : { id: req.params.id, userId: req.user.id }

    const ticket = await prisma.ticket.update({
      where,
      data: {
        status: 'RESOLVED',
        closedAt: new Date()
      }
    })

    const io = req.app.get('io')

    io?.to(`ticket:${ticket.id}`).emit('ticket:updated', ticket)
    io?.to('admins').emit('ticket:updated')
    io?.to(`user:${ticket.userId}`).emit('ticket:updated', ticket)

    res.json({
      success: true,
      message: 'Ticket đã hoàn thành',
      data: ticket
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const adminGetTickets = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, priority } = req.query

    const pageNumber = parseInt(page)
    const limitNumber = parseInt(limit)

    const where = {}

    if (status) where.status = status
    if (priority) where.priority = priority

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        skip: (pageNumber - 1) * limitNumber,
        take: limitNumber,
        orderBy: [
          {
            updatedAt: 'desc'
          }
        ],
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true
            }
          },
          messages: {
            orderBy: {
              createdAt: 'desc'
            },
            take: 1
          }
        }
      }),
      prisma.ticket.count({ where })
    ])

    const mappedTickets = tickets.map(ticket => {
      const hasUnreadUserMessage = ticket.messages?.[0]?.senderRole === 'USER' && ticket.messages?.[0]?.isRead === false

      return {
        ...ticket,
        hasNewUserMessage: hasUnreadUserMessage,
        unreadCount: hasUnreadUserMessage ? 1 : 0
      }
    })

    res.json({
      success: true,
      data: mappedTickets,
      pagination: {
        page: pageNumber,
        total
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const adminUpdatePriority = async (req, res) => {
  try {
    const { priority, assignedTo } = req.body

    const ticket = await prisma.ticket.update({
      where: {
        id: req.params.id
      },
      data: {
        ...(priority && { priority }),
        ...(assignedTo !== undefined && { assignedTo })
      }
    })

    const io = req.app.get('io')

    io?.to(`ticket:${ticket.id}`).emit('ticket:updated', ticket)
    io?.to('admins').emit('ticket:updated')

    res.json({
      success: true,
      data: ticket
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

module.exports = {
  createTicket,
  getMyTickets,
  getMyUnreadCount,
  getTicketDetail,
  sendMessage,
  closeTicket,
  resolveTicket,
  adminGetTickets,
  adminUpdatePriority
}