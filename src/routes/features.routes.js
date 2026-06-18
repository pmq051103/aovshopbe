const express = require('express')
const { protect: authenticate, adminOnly: requireAdmin } = require('../middleware/authMiddleware')

// ── AFFILIATE ROUTES ──────────────────────────────────────────────────────────
const affiliateRouter = express.Router()
const {
  applyAffiliate, getMyAffiliate, requestWithdrawal, validateAffiliateCode,
  adminGetAffiliates, adminApproveAffiliate, adminProcessWithdrawal
} = require('../controllers/affiliate.controller')

affiliateRouter.get('/validate/:code', validateAffiliateCode)                          // public
affiliateRouter.post('/apply', authenticate, applyAffiliate)                           // user đăng ký CTV
affiliateRouter.get('/me', authenticate, getMyAffiliate)                               // thông tin CTV của tôi
affiliateRouter.post('/withdraw', authenticate, requestWithdrawal)                     // yêu cầu rút tiền

affiliateRouter.get('/admin/list', authenticate, requireAdmin, adminGetAffiliates)
affiliateRouter.patch('/admin/:id/status', authenticate, requireAdmin, adminApproveAffiliate)
affiliateRouter.patch('/admin/withdrawal/:id', authenticate, requireAdmin, adminProcessWithdrawal)

// ── VIP ROUTES ────────────────────────────────────────────────────────────────
const vipRouter = express.Router()
const { getVipTiers, getMyVip, adminCreateTier, adminUpdateTier, adminDeleteTier, adminGetMembers } =
  require('../controllers/vip.controller')

vipRouter.get('/tiers', getVipTiers)                                                   // public
vipRouter.get('/me', authenticate, getMyVip)                                           // user

vipRouter.post('/admin/tiers', authenticate, requireAdmin, adminCreateTier)
vipRouter.patch('/admin/tiers/:id', authenticate, requireAdmin, adminUpdateTier)
vipRouter.delete('/admin/tiers/:id', authenticate, requireAdmin, adminDeleteTier)
vipRouter.get('/admin/members', authenticate, requireAdmin, adminGetMembers)

// ── WISHLIST ROUTES ───────────────────────────────────────────────────────────
const wishlistRouter = express.Router()
const { getWishlist, toggleWishlist, checkWishlist } = require('../controllers/wishlist.controller')

wishlistRouter.get('/', authenticate, getWishlist)
wishlistRouter.post('/toggle', authenticate, toggleWishlist)
wishlistRouter.get('/check/:accountId', authenticate, checkWishlist)

// ── COMPARE ROUTES ────────────────────────────────────────────────────────────
const compareRouter = express.Router()
const { compareAccounts } = require('../controllers/wishlist.controller')

compareRouter.post('/', compareAccounts)                                               // public

// ── LAYAWAY ROUTES ────────────────────────────────────────────────────────────
const layawayRouter = express.Router()

const {
  createLayaway,
  getMyLayaways,
  getLayawayDetail,
  payLayaway,
  adminGetLayaways,
  adminRecordPayment,
  adminCancelLayaway,
  adminSendReminderToUser,
} = require('../controllers/layaway.controller')

layawayRouter.post('/', authenticate, createLayaway)
layawayRouter.get('/me', authenticate, getMyLayaways)
layawayRouter.get('/me/:id', authenticate, getLayawayDetail)

// user tự thanh toán tiếp bằng số dư shop
layawayRouter.post('/:id/pay', authenticate, payLayaway)

layawayRouter.get('/admin', authenticate, requireAdmin, adminGetLayaways)
layawayRouter.post('/admin/:id/payment', authenticate, requireAdmin, adminRecordPayment)
layawayRouter.patch('/admin/:id/cancel', authenticate, requireAdmin, adminCancelLayaway)
layawayRouter.post('/admin/:id/send-reminder', authenticate, requireAdmin, adminSendReminderToUser)


// ── INSTALLMENT ROUTES ────────────────────────────────────────────────────────
const installmentRouter = express.Router()
const { createRequest, getMyRequests, adminGetRequests, adminUpdateRequest } =
  require('../controllers/installment.controller')

installmentRouter.post('/', authenticate, createRequest)
installmentRouter.get('/me', authenticate, getMyRequests)

installmentRouter.get('/admin', authenticate, requireAdmin, adminGetRequests)
installmentRouter.patch('/admin/:id', authenticate, requireAdmin, adminUpdateRequest)

// ── EXPORT TẤT CẢ ────────────────────────────────────────────────────────────
module.exports = { affiliateRouter, vipRouter, wishlistRouter, compareRouter, layawayRouter, installmentRouter }