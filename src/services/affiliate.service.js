const prisma = require('../config/prisma')
const { emitToUser, emitToAdmins } = require('../config/socket')

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
// - Luôn tính hoa hồng theo bậc HIỆN TẠI của CTV (sau khi đã cộng lượt nếu có).
// - Hoa hồng được cộng vào SỐ DƯ AFFILIATE (availableBalance) — KHÔNG cộng thẳng vào balance shop của CTV.
//   CTV phải tự yêu cầu rút tiền hoặc quy đổi sang số dư shop để sử dụng.
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

      // Cộng vào số dư affiliate (availableBalance) — KHÔNG cộng vào user.balance
      await tx.affiliate.update({
        where: { id: affiliate.id },
        data: {
          totalEarned: { increment: commission },
          availableBalance: { increment: commission }
        }
      })

      await tx.notification.create({
        data: {
          userId: affiliate.userId,
          type: 'AFFILIATE_COMMISSION',
          title: '💸 Nhận hoa hồng CTV!',
          message: `${buyerName} đã mua hàng. Bạn được nhận ${commission.toLocaleString('vi-VN')}đ hoa hồng (${rate}%, bậc ${tier.name}) vào số dư CTV.`,
          data: { commission, rate, tierName: tier.name, buyerName, event: 'REFERRAL_PURCHASE' }
        }
      })

      // Thông báo real-time (không await để không chặn transaction)
      emitToUser(affiliate.userId, 'affiliate:update', {})
      emitToUser(affiliate.userId, 'notification', {
        type: 'AFFILIATE_COMMISSION',
        title: '💸 Nhận hoa hồng CTV!',
        message: `${buyerName} đã mua hàng. Bạn được nhận ${commission.toLocaleString('vi-VN')}đ hoa hồng vào số dư CTV.`
      })
    })
  } catch (err) {
    // Lỗi affiliate không được làm ảnh hưởng tới luồng mua hàng chính (đã commit rồi)
    console.error('processReferralPurchase error:', err)
  }
}

// ── Số tiền rút tối thiểu do admin cấu hình (SiteConfig, key: affiliate_min_withdraw) ──
const DEFAULT_MIN_WITHDRAW = 50000
const getAffiliateMinWithdraw = async () => {
  const config = await prisma.siteConfig.findUnique({ where: { key: 'affiliate_min_withdraw' } })
  const value = parseFloat(config?.value)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_WITHDRAW
}

// ── User: gửi yêu cầu rút tiền từ số dư affiliate ──────────────────────────────
// Trừ availableBalance NGAY khi gửi yêu cầu (giữ chỗ, tránh rút trùng/rút vượt số dư).
// Nếu admin từ chối, số tiền được hoàn lại (xem rejectWithdrawal).
const requestWithdrawal = async (userId, amount) => {
  const affiliate = await prisma.affiliate.findUnique({ where: { userId } })
  if (!affiliate) throw new Error('Bạn chưa đăng ký CTV')
  if (affiliate.status !== 'ACTIVE') throw new Error('Tài khoản CTV của bạn chưa được duyệt hoặc đã bị khóa')
  if (!affiliate.bankName || !affiliate.bankAccountNumber || !affiliate.bankAccountHolder)
    throw new Error('Vui lòng cập nhật thông tin tài khoản nhận tiền trước khi rút')

  const amountNum = Math.round(parseFloat(amount))
  if (!amountNum || amountNum <= 0) throw new Error('Số tiền rút không hợp lệ')

  const minWithdraw = await getAffiliateMinWithdraw()
  if (amountNum < minWithdraw)
    throw new Error(`Số tiền rút tối thiểu là ${minWithdraw.toLocaleString('vi-VN')}đ`)

  if (amountNum > parseFloat(affiliate.availableBalance))
    throw new Error('Số dư CTV không đủ để rút số tiền này')

  const withdrawal = await prisma.$transaction(async (tx) => {
    await tx.affiliate.update({
      where: { id: affiliate.id },
      data: { availableBalance: { decrement: amountNum } }
    })

    return tx.affiliateWithdrawal.create({
      data: {
        affiliateId: affiliate.id,
        amount: amountNum,
        bankName: affiliate.bankName,
        bankAccountNumber: affiliate.bankAccountNumber,
        bankAccountHolder: affiliate.bankAccountHolder,
        status: 'PENDING'
      }
    })
  })

  emitToAdmins('admin:new_affiliate_withdrawal', { withdrawalId: withdrawal.id, affiliateId: affiliate.id, amount: amountNum })

  return withdrawal
}

// ── Admin: duyệt (hoàn thành, đã chuyển khoản) hoặc từ chối (hoàn tiền) yêu cầu rút ──
const processWithdrawal = async (withdrawalId, action, adminUserId, rejectReason = null) => {
  const withdrawal = await prisma.affiliateWithdrawal.findUnique({
    where: { id: withdrawalId },
    include: { affiliate: true }
  })
  if (!withdrawal) throw new Error('Không tìm thấy yêu cầu rút tiền')
  if (withdrawal.status !== 'PENDING') throw new Error('Yêu cầu này đã được xử lý')

  if (action === 'COMPLETE') {
    const updated = await prisma.affiliateWithdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'COMPLETED', processedAt: new Date(), processedBy: adminUserId }
    })

    await prisma.notification.create({
      data: {
        userId: withdrawal.affiliate.userId,
        type: 'AFFILIATE_COMMISSION',
        title: '✅ Yêu cầu rút tiền CTV đã hoàn thành',
        message: `Yêu cầu rút ${parseFloat(withdrawal.amount).toLocaleString('vi-VN')}đ của bạn đã được chuyển khoản thành công.`,
        data: { withdrawalId, event: 'WITHDRAWAL_COMPLETED' }
      }
    })
    emitToUser(withdrawal.affiliate.userId, 'affiliate:update', {})
    emitToUser(withdrawal.affiliate.userId, 'notification', {
      type: 'AFFILIATE_COMMISSION',
      title: '✅ Yêu cầu rút tiền CTV đã hoàn thành',
      message: `Yêu cầu rút ${parseFloat(withdrawal.amount).toLocaleString('vi-VN')}đ của bạn đã được chuyển khoản thành công.`
    })
    return updated
  }

  if (action === 'REJECT') {
    if (!rejectReason || !rejectReason.trim()) throw new Error('Vui lòng nhập lý do từ chối')

    const updated = await prisma.$transaction(async (tx) => {
      // Hoàn lại số dư affiliate đã giữ chỗ
      await tx.affiliate.update({
        where: { id: withdrawal.affiliateId },
        data: { availableBalance: { increment: withdrawal.amount } }
      })

      return tx.affiliateWithdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'REJECTED',
          rejectReason: rejectReason.trim(),
          processedAt: new Date(),
          processedBy: adminUserId
        }
      })
    })

    await prisma.notification.create({
      data: {
        userId: withdrawal.affiliate.userId,
        type: 'AFFILIATE_COMMISSION',
        title: '❌ Yêu cầu rút tiền CTV bị từ chối',
        message: `Yêu cầu rút ${parseFloat(withdrawal.amount).toLocaleString('vi-VN')}đ bị từ chối. Lý do: ${rejectReason.trim()}. Số tiền đã được hoàn lại vào số dư CTV.`,
        data: { withdrawalId, reason: rejectReason.trim(), event: 'WITHDRAWAL_REJECTED' }
      }
    })
    emitToUser(withdrawal.affiliate.userId, 'affiliate:update', {})
    emitToUser(withdrawal.affiliate.userId, 'notification', {
      type: 'AFFILIATE_COMMISSION',
      title: '❌ Yêu cầu rút tiền CTV bị từ chối',
      message: `Lý do: ${rejectReason.trim()}. Số tiền đã được hoàn lại vào số dư CTV.`
    })
    return updated
  }

  throw new Error('Hành động không hợp lệ')
}

// ── User: quy đổi số dư affiliate sang số dư shop (balance) ───────────────────
// Số tiền do người dùng tự nhập. Tạo 1 Transaction loại AFFILIATE_EXCHANGE trong lịch sử giao dịch.
const exchangeToShopBalance = async (userId, amount) => {
  const affiliate = await prisma.affiliate.findUnique({ where: { userId } })
  if (!affiliate) throw new Error('Bạn chưa đăng ký CTV')
  if (affiliate.status !== 'ACTIVE') throw new Error('Tài khoản CTV của bạn chưa được duyệt hoặc đã bị khóa')

  const amountNum = Math.round(parseFloat(amount))
  if (!amountNum || amountNum <= 0) throw new Error('Số tiền quy đổi không hợp lệ')
  if (amountNum > parseFloat(affiliate.availableBalance))
    throw new Error('Số dư CTV không đủ để quy đổi số tiền này')

  const result = await prisma.$transaction(async (tx) => {
    await tx.affiliate.update({
      where: { id: affiliate.id },
      data: { availableBalance: { decrement: amountNum } }
    })

    const userBefore = await tx.user.findUnique({ where: { id: userId } })
    const userAfter = await tx.user.update({
      where: { id: userId },
      data: { balance: { increment: amountNum } }
    })

    const transaction = await tx.transaction.create({
      data: {
        userId,
        type: 'AFFILIATE_EXCHANGE',
        amount: amountNum,
        balanceBefore: userBefore.balance,
        balanceAfter: userAfter.balance,
        description: `Quy đổi số dư CTV sang số dư shop`
      }
    })

    return { transaction, balanceAfter: userAfter.balance }
  })

  emitToUser(userId, 'balance:update', {})
  emitToUser(userId, 'affiliate:update', {})

  return result
}

module.exports = {
  createReferralOnRegister,
  markReferralStep2,
  processReferralPurchase,
  getAffiliateTierFor,
  getAffiliateMinWithdraw,
  requestWithdrawal,
  processWithdrawal,
  exchangeToShopBalance
}
