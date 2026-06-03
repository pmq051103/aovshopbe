const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { protect } = require('../middleware/authMiddleware');
const { uploadAvatar } = require('../config/cloudinary');
const prisma = require('../config/prisma')

router.get('/profile', protect, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id:true,username:true,email:true,displayName:true,avatar:true,role:true,balance:true,totalDeposit:true,totalSpent:true,createdAt:true,lastLogin:true,emailVerified:true }
    });
    res.json({ success: true, data: user });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.put('/profile', protect, async (req, res) => {
  try {
    const { displayName } = req.body;
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { displayName }, select: { id:true,username:true,email:true,displayName:true,avatar:true,balance:true } });
    res.json({ success: true, data: user });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.post('/avatar', protect, uploadAvatar.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Không có file' });
    const user = await prisma.user.update({ where: { id: req.user.id }, data: { avatar: req.file.path, avatarPublicId: req.file.filename } });
    res.json({ success: true, data: { avatar: user.avatar } });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.put('/change-password', protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!await bcrypt.compare(currentPassword, user.password)) return res.status(400).json({ success: false, message: 'Mật khẩu hiện tại không đúng' });
    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } });
    res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (e) { res.status(500).json({ success: false }); }
});

router.get('/transactions', protect, async (req, res) => {
  try {
    const { page = 1, limit = 10, type, fromDate, toDate } = req.query

    const where = { userId: req.user.id }

    if (type) {
      where.type = type
    }

    if (fromDate || toDate) {
      where.createdAt = {}

      if (fromDate) {
        where.createdAt.gte = new Date(`${fromDate}T00:00:00.000Z`)
      }

      if (toDate) {
        where.createdAt.lte = new Date(`${toDate}T23:59:59.999Z`)
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [txs, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          gameAccount: {
            select: {
              code: true,
              title: true
            }
          }
        }
      }),
      prisma.transaction.count({ where })
    ])

    res.json({
      success: true,
      data: txs,
      pagination: {
        page: parseInt(page),
        limit: take,
        total,
        pages: Math.ceil(total / take)
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
})

module.exports = router;
