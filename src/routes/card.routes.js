const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/card.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadCardThumbnail } = require('../config/cloudinary')

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/configs',                   protect, adminOnly, ctrl.adminGetConfigs)
router.get('/admin/products',                  protect, adminOnly, ctrl.adminGetCardProducts)
router.get('/admin/balance',                   protect, adminOnly, ctrl.adminGetCardBalance)
router.post('/admin/configs',                  protect, adminOnly, uploadCardThumbnail.single('thumbnail'), ctrl.adminCreateConfig)
router.post('/admin/configs/bulk',             protect, adminOnly, uploadCardThumbnail.single('thumbnail'), ctrl.adminBulkCreateConfig)
router.put('/admin/configs/:id',               protect, adminOnly, uploadCardThumbnail.single('thumbnail'), ctrl.adminUpdateConfig)
router.delete('/admin/configs/:id',            protect, adminOnly, ctrl.adminDeleteConfig)
router.delete('/admin/configs/telco/:telco',   protect, adminOnly, ctrl.adminDeleteConfigsByTelco)
router.put('/admin/configs/telco/:telco',      protect, adminOnly, uploadCardThumbnail.single('thumbnail'), ctrl.adminUpdateConfigsByTelco)
router.delete('/admin/configs/:id/thumbnail',  protect, adminOnly, ctrl.adminDeleteConfigThumbnail)
router.put('/admin/configs/telco/:telco/thumbnail', protect, adminOnly, uploadCardThumbnail.single('thumbnail'), ctrl.adminUpdateTelcoThumbnail)
router.get('/admin/deposits',                  protect, adminOnly, ctrl.adminGetDeposits)
router.put('/admin/deposits/:id/status',       protect, adminOnly, ctrl.adminUpdateDepositStatus)
router.get('/admin/purchases',                 protect, adminOnly, ctrl.adminGetPurchases)
router.post('/admin/purchases/:id/resend',     protect, adminOnly, ctrl.adminResendPurchase)
router.get('/admin/check-card',                protect, adminOnly, ctrl.adminCheckCardSerial)
router.get('/admin/charging-price-list',       protect, adminOnly, ctrl.adminGetChargingPriceList)

// ── Public — cấu hình thẻ (để FE render form) ─────────────────────────────
router.get('/configs', ctrl.getPublicConfigs)

// ── Nạp thẻ ──────────────────────────────────────────────────────────────────
router.post('/deposit',           protect, ctrl.depositCard)
router.get('/deposit/history',    protect, ctrl.getDepositHistory)
router.get('/deposit/:id/status', protect, ctrl.getDepositStatus)
router.post('/callback',          ctrl.cardCallback)   // no auth — từ đối tác gọi về


// để nhà cung cấp hoặc ngrok check endpoint
router.get('/callback', (req, res) => {
  res.json({
    status: 200,
    message: 'callback endpoint ok',
  })
})

// ── Mua thẻ ──────────────────────────────────────────────────────────────────
router.post('/buy',         protect, ctrl.buyCard)
router.get('/buy/history',  protect, ctrl.getBuyHistory)
router.get('/buy/:id',      protect, ctrl.getBuyDetail)

module.exports = router