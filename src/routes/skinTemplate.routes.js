const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/skinTemplate.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadAccountImages } = require('../config/cloudinary')

// Public
router.get('/heroes', ctrl.getHeroes)
router.get('/stats',  ctrl.getStats)

// Admin only
router.get('/',       protect, adminOnly, ctrl.list)
router.post('/',      protect, adminOnly, uploadAccountImages.single('image'), ctrl.create)
router.put('/:id',    protect, adminOnly, uploadAccountImages.single('image'), ctrl.update)
router.delete('/:id', protect, adminOnly, ctrl.remove)

// AI detect endpoints
router.post('/detect/:accountId',  protect, adminOnly, ctrl.detectSkins)
router.post('/confirm/:accountId', protect, adminOnly, ctrl.confirmSkins)

module.exports = router