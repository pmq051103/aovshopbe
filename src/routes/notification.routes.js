const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const prisma = require('../config/prisma')

router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        skip: (parseInt(page)-1)*parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.notification.count({ where: { userId: req.user.id, isRead: false } })
    ]);
    res.json({ success: true, data: notifications, unreadCount });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.put('/read-all', protect, async (req, res) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user.id, isRead: false }, data: { isRead: true, readAt: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.put('/:id/read', protect, async (req, res) => {
  try {
    await prisma.notification.update({ where: { id: req.params.id }, data: { isRead: true, readAt: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

module.exports = router;
