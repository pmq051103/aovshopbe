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

// Nhiều nghiệp vụ khác nhau (mua acc, mua thẻ, đặt cọc, nạp điện thoại...) đều
// dùng chung type = 'PURCHASE' trong bảng transaction, nên không thể phân biệt
// chỉ bằng `type`. Suy ra nhãn chính xác hơn từ nội dung `description` đã lưu
// lúc tạo transaction ở từng controller.
function resolveLabel(type, description = '') {
  if (type === 'PURCHASE') {
    if (/^mua\s+\d+\s+thẻ/i.test(description) || /\bthẻ\b/i.test(description)) {
      return 'vừa mua thẻ'
    }
    if (/^đặt cọc/i.test(description) || /^thanh toán đặt cọc/i.test(description)) {
      return 'vừa đặt cọc tài khoản'
    }
    if (/nạp tiền điện thoại/i.test(description)) {
      return 'vừa nạp tiền điện thoại'
    }
    if (/^mua acc/i.test(description)) {
      return 'vừa mua tài khoản'
    }
  }
  return TYPE_LABEL[type] || 'vừa thực hiện giao dịch'
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
        description: true,
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
        label: resolveLabel(t.type, t.description),
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