const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/wheel.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const rateLimiter = require('../middleware/rateLimiter')
const { uploadBanner } = require('../config/cloudinary')

router.get('/', ctrl.getWheel)
router.get('/winners', ctrl.getRecentWinners)
router.post('/spin', protect, rateLimiter.spin, ctrl.spin)
router.get('/history', protect, ctrl.getHistory)

// Admin
router.get('/admin/all', protect, adminOnly, ctrl.adminGetWheels)
router.get('/admin/:id/stats', protect, adminOnly, ctrl.adminGetWheelStats)
router.post('/admin', protect, adminOnly, uploadBanner.single('image'), ctrl.adminCreateWheel)
router.put('/admin/rewards/:id', protect, adminOnly, uploadBanner.single('image'), ctrl.adminUpdateReward)
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDeleteWheel)
router.post('/admin/:wheelId/rewards', protect, adminOnly, uploadBanner.single('image'), ctrl.adminCreateReward)
router.put('/admin/:id', protect, adminOnly, uploadBanner.single('image'), ctrl.adminUpdateWheel)
//router.put('/admin/rewards/:id', protect, adminOnly, ctrl.adminUpdateReward)
router.delete('/admin/rewards/:id', protect, adminOnly, ctrl.adminDeleteReward)
router.get('/admin/history', protect, adminOnly, ctrl.adminGetWheelHistory)

module.exports = router
