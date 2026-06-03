const express = require('express')
const router = express.Router()
const { getMyOrders, getOrderById, requestRefund, adminGetOrders, adminRefundOrder, adminGetOrderStats, getRecentActivity } = require('../controllers/order.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

router.get('/recent-activity', getRecentActivity)
router.get('/', protect, getMyOrders)
router.get('/admin/stats', protect, adminOnly, adminGetOrderStats)
router.get('/admin', protect, adminOnly, adminGetOrders)
router.get('/:id', protect, getOrderById)
router.post('/:id/refund', protect, requestRefund)
router.post('/admin/:id/refund', protect, adminOnly, adminRefundOrder)

module.exports = router