const express = require('express')
const router = express.Router()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const TYPE_LABEL = {
  DEPOSIT: 'vừa nạp tiền',
  PURCHASE: 'vừa mua tài khoản',
  SPIN: 'vừa quay vòng quay',
  MYSTERY_BOX: 'vừa mở hộp bí ẩn',
  REWARD: 'vừa nhận thưởng',
  TOPUP_PURCHASE: 'vừa mua nạp Quân Huy',
  REFUND: 'vừa được hoàn tiền',
}

// GET /api/activity/recent — public, không cần auth
router.get('/recent', async (req, res) => {
  try {
    const transactions = await prisma.transaction.findMany({
      where: { status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        type: true,
        amount: true,
        createdAt: true,
        user: {
          select: { username: true, displayName: true }
        }
      }
    })

    const data = transactions.map(t => {
      const name = t.user?.displayName || t.user?.username || 'Người dùng'
      // Ẩn bớt tên: giữ 3 ký tự đầu + ***
      const masked = name.length > 3 ? name.slice(0, 3) + '***' : name + '***'
      return {
        username: masked,
        type: t.type,
        label: TYPE_LABEL[t.type] || 'vừa thực hiện giao dịch',
        amount: parseFloat(t.amount),
        createdAt: t.createdAt,
      }
    })

    res.json({ success: true, data })
  } catch (e) {
    console.error('[Activity] Error:', e.message)
    res.json({ success: true, data: [] })
  }
})

module.exports = router