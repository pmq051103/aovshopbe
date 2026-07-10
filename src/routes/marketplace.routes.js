const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/marketplace.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

// Public
router.get('/', ctrl.getListings)
router.get('/fee', ctrl.getPublicFeePercent)

// User (đặt trước /:id để không bị route generic nuốt mất)
router.get('/mine/sellable', protect, ctrl.getMySellableAccounts)
router.get('/mine/listings', protect, ctrl.getMyListings)
router.get('/mine/purchases', protect, ctrl.getMyPurchases)
router.post('/', protect, ctrl.createListing)
router.post('/:id/cancel', protect, ctrl.cancelListing)
router.post('/:id/buy', protect, ctrl.buyListing)

router.get('/:id', ctrl.getListingDetail)

// Admin
router.get('/admin/all', protect, adminOnly, ctrl.adminGetListings)
router.post('/admin/:id/approve', protect, adminOnly, ctrl.adminApproveListing)
router.post('/admin/:id/reject', protect, adminOnly, ctrl.adminRejectListing)
router.get('/admin/fee', protect, adminOnly, ctrl.adminGetFeePercent)
router.put('/admin/fee', protect, adminOnly, ctrl.adminSetFeePercent)

module.exports = router
