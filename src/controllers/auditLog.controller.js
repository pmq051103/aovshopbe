const prisma = require('../config/prisma')

// Middleware to log admin actions
const auditLog = (action, targetType, getDescription) => async (req, res, next) => {
  const originalJson = res.json.bind(res)
  res.json = async (body) => {
    if (body?.success && req.user?.role === 'ADMIN') {
      try {
        const targetId = req.params?.id || body?.data?.id || null
        const description = typeof getDescription === 'function'
          ? getDescription(req, body)
          : getDescription
        await prisma.auditLog.create({
          data: {
            adminId: req.user.id,
            adminName: req.user.displayName || req.user.username,
            action,
            targetType,
            targetId: targetId ? String(targetId) : null,
            description,
            ipAddress: req.ip || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent'],
            metadata: { body: req.body, params: req.params, query: req.query }
          }
        })
      } catch (e) {
        // Don't fail request if audit log fails
        console.error('Audit log error:', e.message)
      }
    }
    return originalJson(body)
  }
  next()
}

// Admin: get audit logs
const getAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, action, adminId, from, to } = req.query
    const where = {}
    if (action) where.action = action
    if (adminId) where.adminId = adminId
    if (from || to) where.createdAt = {
      ...(from && { gte: new Date(from) }),
      ...(to && { lte: new Date(to) })
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where, skip: (page - 1) * parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.auditLog.count({ where })
    ])
    res.json({ success: true, data: logs, pagination: { page: parseInt(page), total } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = { auditLog, getAuditLogs }