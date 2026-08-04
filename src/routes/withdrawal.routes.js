const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/withdrawal.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

// ── USER (rút tiền từ số dư BÁN ACC) ────────────────────────────────────────
router.get('/me', protect, ctrl.getMyWithdrawInfo)          // số dư bán acc + bank + lịch sử
router.put('/bank-info', protect, ctrl.updateBankInfo)      // lưu thông tin ngân hàng
router.post('/', protect, ctrl.createWithdrawal)            // tạo yêu cầu rút
router.post('/:id/cancel', protect, ctrl.cancelWithdrawal)  // huỷ yêu cầu khi còn chờ

// ── ADMIN ───────────────────────────────────────────────────────────────────
router.get('/admin/settings', protect, adminOnly, ctrl.adminGetSettings)
router.put('/admin/settings', protect, adminOnly, ctrl.adminUpdateSettings)
router.get('/admin', protect, adminOnly, ctrl.adminListWithdrawals)
router.put('/admin/:id/process', protect, adminOnly, ctrl.adminProcessWithdrawal)

module.exports = router
