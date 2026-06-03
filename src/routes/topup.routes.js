const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/topup.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadBoxImage } = require('../config/cloudinary')
const rateLimiter = require('../middleware/rateLimiter')

// Public
router.get('/packages', ctrl.getPackages)

// User
router.post('/orders', protect, rateLimiter.deposit, ctrl.createOrder)
router.get('/orders/my', protect, ctrl.getMyOrders)

// Admin
router.get('/admin/orders', protect, adminOnly, ctrl.adminGetOrders)
router.put('/admin/orders/:id/complete', protect, adminOnly, ctrl.adminCompleteOrder)
router.put('/admin/orders/:id/cancel', protect, adminOnly, ctrl.adminCancelOrder)
router.put('/admin/orders/:id/process', protect, adminOnly, ctrl.adminProcessOrder)
router.get('/admin/packages', protect, adminOnly, ctrl.adminGetPackages)
router.post('/admin/packages', protect, adminOnly, uploadBoxImage.single('image'), ctrl.adminCreatePackage)
router.put('/admin/packages/:id', protect, adminOnly, uploadBoxImage.single('image'), ctrl.adminUpdatePackage)
router.delete('/admin/packages/:id', protect, adminOnly, ctrl.adminDeletePackage)

module.exports = router
