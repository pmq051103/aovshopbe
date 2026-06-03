const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/category.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBanner } = require('../config/cloudinary')

router.get('/', ctrl.getCategories)
router.get('/admin', protect, adminOnly, ctrl.adminGetCategories)
router.get('/:slug', ctrl.getCategoryBySlug)
router.post('/admin', protect, adminOnly, uploadBanner.single('image'), ctrl.adminCreateCategory)
router.put('/admin/:id', protect, adminOnly, uploadBanner.single('image'), ctrl.adminUpdateCategory)
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDeleteCategory)
router.post('/admin/account-categories', protect, adminOnly, ctrl.setAccountCategories)

module.exports = router
