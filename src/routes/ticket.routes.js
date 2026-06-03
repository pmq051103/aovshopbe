const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/ticket.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBanner } = require('../config/cloudinary')

router.post('/', protect, ctrl.createTicket)
router.get('/my', protect, ctrl.getMyTickets)
router.get('/my/unread-count', protect, ctrl.getMyUnreadCount)
router.get('/admin', protect, adminOnly, ctrl.adminGetTickets)
router.get('/:id', protect, ctrl.getTicketDetail)
router.post('/:id/message', protect, uploadBanner.single('image'), ctrl.sendMessage)
router.put('/:id/close', protect, ctrl.closeTicket)
router.put('/:id/resolve', protect, adminOnly, ctrl.resolveTicket)
router.put('/admin/:id/priority', protect, adminOnly, ctrl.adminUpdatePriority)

module.exports = router