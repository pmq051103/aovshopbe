const express = require('express')
const router = express.Router()
const { getAuditLogs } = require('../controllers/auditLog.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

router.get('/', protect, adminOnly, getAuditLogs)

module.exports = router