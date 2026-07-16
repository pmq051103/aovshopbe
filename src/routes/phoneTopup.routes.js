const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/phoneTopup.controller')
const { protect, adminOnly, optionalAuth } = require('../middleware/authMiddleware')
const { uploadCardThumbnail } = require('../config/cloudinary') // dùng lại uploader ảnh sẵn có

// ── Admin ────────────────────────────────────────────────────────────────
router.post('/admin/sync-products',  protect, adminOnly, ctrl.adminSyncProducts)
router.get('/admin/balance',         protect, adminOnly, ctrl.adminGetBalance)
router.get('/admin/configs',         protect, adminOnly, ctrl.adminGetConfigs)
router.put('/admin/configs/:id',     protect, adminOnly, uploadCardThumbnail.single('thumbnail'), ctrl.adminUpdateConfig)
router.get('/admin/orders',          protect, adminOnly, ctrl.adminGetOrders)
router.put('/admin/orders/:id/resolve', protect, adminOnly, ctrl.adminResolveOrder)

// ── Public / User ────────────────────────────────────────────────────────
router.get('/configs',           optionalAuth, ctrl.getPublicConfigs)
router.post('/order',            protect, ctrl.createTopupOrder)
router.get('/order/:id/check',   protect, ctrl.checkOrderStatus)
router.get('/my-orders',         protect, ctrl.getMyOrders)
router.post('/callback',         ctrl.phoneTopupCallback)   // no auth — từ đối tác gọi về

// để nhà cung cấp hoặc ngrok check endpoint
router.get('/callback', (req, res) => {
  res.json({
    status: 200,
    message: 'phone topup callback endpoint ok',
  })
})

module.exports = router