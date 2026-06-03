const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/coupon.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

router.get('/public', ctrl.getPublicCoupons)
router.post('/validate', protect, ctrl.validateCoupon)
router.get('/admin', protect, adminOnly, ctrl.adminGetCoupons)
router.post('/admin', protect, adminOnly, ctrl.adminCreateCoupon)
router.put('/admin/:id', protect, adminOnly, ctrl.adminUpdateCoupon)
router.delete('/admin/:id', protect, adminOnly, ctrl.adminDeleteCoupon)

module.exports = router
