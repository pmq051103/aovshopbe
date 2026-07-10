const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/achievement.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

router.get('/', ctrl.getAllAchievements)
router.get('/mine', protect, ctrl.getMyAchievements)

// Admin
router.get('/admin/all', protect, adminOnly, ctrl.adminGetAchievements)
router.post('/admin', protect, adminOnly, ctrl.adminCreateAchievement)
router.put('/admin/:id', protect, adminOnly, ctrl.adminUpdateAchievement)
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDeleteAchievement)

module.exports = router
