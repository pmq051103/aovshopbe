const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/ownedAccount.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

router.get('/my', protect, ctrl.getMyOwnedAccounts)
router.get('/my/:id', protect, ctrl.getOwnedAccountDetail)
router.post('/admin/gift', protect, adminOnly, ctrl.adminGiftAccount)
router.get('/admin/all', protect, adminOnly, ctrl.adminGetAllOwned)

module.exports = router

