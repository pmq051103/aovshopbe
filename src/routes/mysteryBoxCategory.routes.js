const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/mysteryBoxCategory.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBoxImage } = require('../config/cloudinary')

// Upload fields cho category (thumbnail + banner)
const uploadCategoryImages = uploadBoxImage.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'banner', maxCount: 1 },
  { name: 'detail', maxCount: 1 }
])

// ── USER ──────────────────────────────────────────────────────────
// Top categories sort theo số lần mở — dùng cho homepage
router.get('/', ctrl.getTopBoxes)
// Danh sách category túi mù
router.get('/categories', ctrl.getCategories)
// Lịch sử mua gần đây theo category
router.get('/categories/:id/recent-history', ctrl.getCategoryRecentHistory)
// Chi tiết category + danh sách acc (blurred)
router.get('/categories/:slug', ctrl.getCategoryBySlug)
// Detail 1 acc (vẫn không reveal login)
router.get('/accounts/:id', ctrl.getAccountDetail)
// Mở túi mù (random acc trong category)
router.post('/categories/:id/open', protect, ctrl.openMysteryBox)
// Lịch sử mở túi
router.get('/history', protect, ctrl.getUserHistory)

// ── ADMIN - CATEGORIES ────────────────────────────────────────────
router.get('/admin/categories', protect, adminOnly, ctrl.adminGetCategories)
router.get('/admin/categories/:id/stats', protect, adminOnly, ctrl.adminGetCategoryStats)
router.post('/admin/categories', protect, adminOnly, uploadCategoryImages, ctrl.adminCreateCategory)
router.put('/admin/categories/:id', protect, adminOnly, uploadCategoryImages, ctrl.adminUpdateCategory)
router.delete('/admin/categories/:id', protect, adminOnly, ctrl.adminDeleteCategory)

// ── ADMIN - ACCOUNTS ──────────────────────────────────────────────
router.get('/admin/accounts', protect, adminOnly, ctrl.adminGetAccounts)
router.post('/admin/accounts', protect, adminOnly, ctrl.adminCreateAccount)
router.post('/admin/accounts/bulk-import', protect, adminOnly, ctrl.adminBulkImportAccounts)
router.put('/admin/accounts/:id', protect, adminOnly, ctrl.adminUpdateAccount)
router.delete('/admin/accounts/:id', protect, adminOnly, ctrl.adminDeleteAccount)

// ── ADMIN - HISTORY ───────────────────────────────────────────────
router.get('/admin/history', protect, adminOnly, ctrl.adminGetOpenHistory)

module.exports = router