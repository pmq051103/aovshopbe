const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/badge.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBanner } = require('../config/cloudinary')

router.get('/', ctrl.getAllBadges)
router.get('/user/:userId', ctrl.getUserBadges)

// Admin
router.get('/admin/all', protect, adminOnly, ctrl.adminGetBadges)
router.post('/admin', protect, adminOnly, uploadBanner.single('image'), ctrl.adminCreateBadge)
router.put('/admin/:id', protect, adminOnly, uploadBanner.single('image'), ctrl.adminUpdateBadge)
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDeleteBadge)
router.post('/admin/grant', protect, adminOnly, ctrl.adminGrantBadge)
router.delete('/admin/revoke/:userId/:badgeId', protect, adminOnly, ctrl.adminRevokeBadge)

module.exports = router
