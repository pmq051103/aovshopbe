const express = require('express');
const router = express.Router();
const { createDeposit, getDepositHistory, webhook, confirmDeposit } = require('../controllers/deposit.controller');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const rateLimiter = require('../middleware/rateLimiter');

// Route dành cho user
router.post('/', protect, rateLimiter.deposit, createDeposit);
router.get('/history', protect, getDepositHistory);

// Webhook PayOS — KHÔNG cần auth, PayOS sẽ gọi vào đây
// Đặt trước các route có :id để tránh conflict
router.post('/webhook', express.json(), webhook);

// Admin xác nhận thủ công
router.post('/:id/confirm', protect, adminOnly, confirmDeposit);

module.exports = router;
