const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/announcement.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

// Public
router.get('/active', ctrl.getActive)

// Admin
router.get('/admin', protect, adminOnly, ctrl.adminGetAll)
router.post('/admin', protect, adminOnly, ctrl.adminCreate)
router.put('/admin/:id', protect, adminOnly, ctrl.adminUpdate)
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDelete)
router.patch('/admin/:id/toggle', protect, adminOnly, ctrl.adminToggle)

module.exports = router
