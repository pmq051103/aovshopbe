const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/auction.controller')
const { protect, adminOnly, optionalAuth } = require('../middleware/authMiddleware')
const rateLimiter = require('../middleware/rateLimiter')
const { uploadBanner } = require('../config/cloudinary')

router.get('/', ctrl.getRooms)
router.get('/ended', ctrl.getEndedRooms)
router.get('/:id', optionalAuth, ctrl.getRoomDetail)
router.post('/:id/bid', protect, rateLimiter.bid, ctrl.placeBid)

// Admin
router.get('/admin/all', protect, adminOnly, ctrl.adminGetRooms)
router.post('/admin', protect, adminOnly, uploadBanner.single('image'), ctrl.adminCreateRoom)
router.put('/admin/:id', protect, adminOnly, uploadBanner.single('image'), ctrl.adminUpdateRoom)
router.post('/admin/:id/start', protect, adminOnly, ctrl.adminStartRoom)
router.post('/admin/:id/cancel', protect, adminOnly, ctrl.adminCancelRoom)

module.exports = router
