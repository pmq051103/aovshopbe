const express = require('express')
const router = express.Router()

const {
  getAccounts,
  getAccountById,
  buyAccount,
  previewCoupon,
  createAccount,
  updateAccount,
  deleteAccount,
  getFilters
} = require('../controllers/account.controller')

const { protect, adminOnly, optionalAuth } = require('../middleware/authMiddleware')
const { uploadAccountImages } = require('../config/cloudinary')

router.get('/', getAccounts)
router.get('/filters', getFilters)

router.post(
  '/',
  protect,
  adminOnly,
  uploadAccountImages.array('images', 10),
  createAccount
)

router.post('/coupon/preview', protect, previewCoupon)

router.get('/:id', optionalAuth, getAccountById)
router.post('/:id/buy', protect, buyAccount)

router.put(
  '/:id',
  protect,
  adminOnly,
  uploadAccountImages.array('images', 10),
  updateAccount
)

router.delete('/:id', protect, adminOnly, deleteAccount)

module.exports = router