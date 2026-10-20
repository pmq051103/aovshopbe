const express = require('express');
const router = express.Router();
const { getDashboardStats, getUsers, banUser, unbanUser, adjustBalance, adjustQuanHuy, getAllDeposits, getBadgeCounts, getUserActivity } = require('../controllers/admin.controller');
const { protect, adminOnly } = require('../middleware/authMiddleware');

router.use(protect, adminOnly);
router.get('/dashboard', getDashboardStats);
router.get('/badge-counts', getBadgeCounts);
router.get('/users', getUsers);
router.get('/users/:id/activity', getUserActivity);
router.put('/users/:id/ban', banUser);
router.put('/users/:id/unban', unbanUser);
router.post('/users/:id/balance', adjustBalance);
router.post('/users/:id/quan-huy', adjustQuanHuy);
router.get('/deposits', getAllDeposits);

module.exports = router;
