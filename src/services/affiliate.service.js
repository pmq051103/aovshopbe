const prisma = require('../config/prisma')
const { emitToUser } = require('../config/socket')

// ── Bước 1: Tạo tài khoản bằng link giới thiệu ─────────────────────────────────
// Gọi từ auth.controller (register) SAU KHI user đã được tạo thành công (không cần chung transaction).
const createReferralOnRegister = async (refCode, newUserId) => {
  if (!refCode) return
  try {
    const affiliate = await prisma.affiliate.findUnique({ where: { code: refCode } })
    if (!affiliate || affiliate.status !== 'ACTIVE') return
    if (affiliate.userId === newUserId) return // không tự giới thiệu bản thân

    const newUser = await prisma.user.findUnique({
      where: { id: newUserId },
      select: { username: true, displayName: true }
    })
    const newUserName = newUser?.displayName || newUser?.username || 'Người dùng mới'

    await prisma.$transaction([
      prisma.affiliateReferral.create({
        data: { affiliateId: affiliate.id, referredUserId: newUserId }
      }),
      prisma.affiliate.update({
        where: { id: affiliate.id },
        data: { totalReferrals: { increment: 1 } }
      }),
      prisma.notification.create({
        data: {
          userId: affiliate.userId,
          type: 'AFFILIATE_COMMISSION',
          title: '🎉 Có người đăng ký qua link của bạn!',
          message: `${newUserName} đã đăng ký bằng link giới thiệu của bạn. Khi họ mua hàng, bạn sẽ nhận hoa hồng.`,
          data: { event: 'REFERRAL_REGISTERED', referredUserName: newUserName }
        }
      })
    ])

    emitToUser(affiliate.userId, 'notification', {
      type: 'AFFILIATE_COMMISSION',
      title: '🎉 Có người đăng ký qua link của bạn!',
      message: `${newUserName} đã đăng ký bằng link giới thiệu của bạn.`
    })
  } catch (err) {
    // Không chặn đăng ký nếu có lỗi liên quan affiliate (vd: refCode rác)
    console.error('createReferralOnRegister error:', err)
  }
}

// ── Bước 2: Nạp tiền lần đầu ────────────────────────────────────────────────────
// Gọi từ deposit.controller (webhook / confirmDeposit) sau khi nạp tiền thành công.
const markReferralStep2 = async (userId) => {
  try {
    const referral = await prisma.affiliateReferral.findUnique({ where: { referredUserId: userId } })
    if (!referral || referral.step2At) return // chưa được giới thiệu, hoặc đã đánh dấu rồi

    await prisma.affiliateReferral.update({
      where: { id: referral.id },
      data: { step2At: new Date() }
    })
  } catch (err) {
    console.error('markReferralStep2 error:', err)
  }
}

// ── Tính bậc CTV hiện tại theo completedReferrals (giống logic VIP theo totalSpent) ──
// client: có thể là `prisma` (ngoài transaction) hoặc `tx` (trong transaction)
const getAffiliateTierFor = async (completedReferrals, client = prisma) => {
  const tiers = await client.affiliateTier.findMany({
    where: { isActive: true },
    orderBy: { minReferrals: 'desc' }
  })
  return tiers.find(t => completedReferrals >= t.minReferrals) || null
}

// ── Bước 3 + Hoa hồng: Mua hàng (lần đầu hoặc các lần sau) ─────────────────────
// QUAN TRỌNG: gọi hàm này SAU KHI transaction đơn hàng đã commit thành công
// (không gọi trong tx của đơn hàng) — để lỗi ở affiliate không làm rollback đơn hàng gốc.
// - Nếu đây là đơn đầu tiên của người được giới thiệu → đánh dấu step3At + completedReferrals +1 (CTV lên bậc nếu đủ điều kiện)
// - Luôn tính hoa hồng theo bậc HIỆN TẠI của CTV (sau khi đã cộng lượt nếu có) và cộng thẳng vào balance CTV.
// orderId: id đơn hàng / lịch sử để truy vết (có thể null).
const processReferralPurchase = async (buyerUserId, orderAmount, orderId = null) => {
  try {
    const referral = await prisma.affiliateReferral.findUnique({
      where: { referredUserId: buyerUserId },
      include: { affiliate: true }
    })
    if (!referral || referral.affiliate.status !== 'ACTIVE') return

    await prisma.$transaction(async (tx) => {
      const affiliate = await tx.affiliate.findUnique({ where: { id: referral.affiliateId } })
      const buyerUser = await tx.user.findUnique({
        where: { id: buyerUserId },
        select: { username: true, displayName: true }
      })
      const buyerName = buyerUser?.displayName || buyerUser?.username || 'Người được giới thiệu'
      const isFirstPurchase = !referral.step3At

      let completedReferrals = affiliate.completedReferrals

      if (isFirstPurchase) {
        await tx.affiliateReferral.update({
          where: { id: referral.id },
          data: { step3At: new Date() }
        })
        completedReferrals = affiliate.completedReferrals + 1
        await tx.affiliate.update({
          where: { id: affiliate.id },
          data: { completedReferrals: { increment: 1 } }
        })
      }

      // Tính bậc theo completedReferrals MỚI NHẤT (đã tính cả lượt vừa hoàn thành nếu có)
      const tier = await getAffiliateTierFor(completedReferrals, tx)
      if (!tier || parseFloat(tier.commissionPercent) <= 0) return

      const rate = parseFloat(tier.commissionPercent)
      const commission = Math.round((parseFloat(orderAmount) * rate) / 100)
      if (commission <= 0) return

      const affiliateUser = await tx.user.findUnique({ where: { id: affiliate.userId } })

      await tx.affiliateCommission.create({
        data: {
          affiliateId: affiliate.id,
          orderId,
          amount: commission,
          rate,
          orderAmount,
          tierName: tier.name
        }
      })

      const updatedAffiliateUser = await tx.user.update({
        where: { id: affiliate.userId },
        data: { balance: { increment: commission } }
      })

      await tx.affiliate.update({
        where: { id: affiliate.id },
        data: { totalEarned: { increment: commission } }
      })

      await tx.transaction.create({
        data: {
          userId: affiliate.userId,
          type: 'AFFILIATE_COMMISSION',
          amount: commission,
          balanceBefore: affiliateUser.balance,
          balanceAfter: updatedAffiliateUser.balance,
          description: `Hoa hồng CTV ${rate}% (bậc ${tier.name}) từ đơn hàng của người được giới thiệu`
        }
      })

      await tx.notification.create({
        data: {
          userId: affiliate.userId,
          type: 'AFFILIATE_COMMISSION',
          title: '💸 Nhận hoa hồng CTV!',
          message: `${buyerName} đã mua hàng. Bạn được nhận ${commission.toLocaleString('vi-VN')}đ hoa hồng (${rate}%, bậc ${tier.name}).`,
          data: { commission, rate, tierName: tier.name, buyerName, event: 'REFERRAL_PURCHASE' }
        }
      })

      // Thông báo real-time (không await để không chặn transaction)
      emitToUser(affiliate.userId, 'balance:update', {})
      emitToUser(affiliate.userId, 'notification', {
        type: 'AFFILIATE_COMMISSION',
        title: '💸 Nhận hoa hồng CTV!',
        message: `${buyerName} đã mua hàng. Bạn được nhận ${commission.toLocaleString('vi-VN')}đ hoa hồng.`
      })
    })
  } catch (err) {
    // Lỗi affiliate không được làm ảnh hưởng tới luồng mua hàng chính (đã commit rồi)
    console.error('processReferralPurchase error:', err)
  }
}

module.exports = {
  createReferralOnRegister,
  markReferralStep2,
  processReferralPurchase,
  getAffiliateTierFor
}
