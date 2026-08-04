const prisma = require('../config/prisma')
const { emitToUser, emitToAdmins } = require('../config/socket')

// Số tiền rút tối thiểu — chỉnh qua SiteConfig key 'withdraw_min_amount'
const DEFAULT_MIN_WITHDRAW = 50000
const getMinWithdraw = async () => {
  try {
    const cfg = await prisma.siteConfig.findUnique({ where: { key: 'withdraw_min_amount' } })
    const v = parseFloat(cfg?.value)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MIN_WITHDRAW
  } catch { return DEFAULT_MIN_WITHDRAW }
}

// Số tiền rút TỐI ĐA mỗi lần — chỉnh qua SiteConfig 'withdraw_max_amount'. 0 = không giới hạn.
const DEFAULT_MAX_WITHDRAW = 0
const getMaxWithdraw = async () => {
  try {
    const cfg = await prisma.siteConfig.findUnique({ where: { key: 'withdraw_max_amount' } })
    const v = parseFloat(cfg?.value)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_WITHDRAW
  } catch { return DEFAULT_MAX_WITHDRAW }
}

// ── USER: lưu / cập nhật thông tin ngân hàng nhận tiền rút ──────────────────
const updateBankInfo = async (req, res) => {
  try {
    const { bankName, bankNumber, bankHolder } = req.body
    if (!bankName?.trim() || !bankNumber?.trim() || !bankHolder?.trim()) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập đủ thông tin ngân hàng' })
    }
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        payoutBankName: bankName.trim(),
        payoutBankNumber: bankNumber.trim(),
        payoutBankHolder: bankHolder.trim(),
      },
    })
    res.json({ success: true, message: 'Đã lưu thông tin ngân hàng' })
  } catch (e) {
    console.error('[updateBankInfo]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi lưu thông tin ngân hàng' })
  }
}

// ── USER: số dư bán acc + thông tin bank + lịch sử rút + hạn mức tối thiểu ───
const getMyWithdrawInfo = async (req, res) => {
  try {
    const [user, withdrawals, minWithdraw, maxWithdraw] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: { sellerBalance: true, payoutBankName: true, payoutBankNumber: true, payoutBankHolder: true },
      }),
      prisma.withdrawalRequest.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      getMinWithdraw(),
      getMaxWithdraw(),
    ])
    res.json({
      success: true,
      data: {
        sellerBalance: user.sellerBalance,
        bank: { bankName: user.payoutBankName, bankNumber: user.payoutBankNumber, bankHolder: user.payoutBankHolder },
        withdrawals,
        minWithdraw,
        maxWithdraw,
      },
    })
  } catch (e) {
    console.error('[getMyWithdrawInfo]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi tải thông tin rút tiền' })
  }
}

// ── USER: tạo yêu cầu rút — TRỪ GIỮ CHỖ ngay từ sellerBalance ───────────────
const createWithdrawal = async (req, res) => {
  try {
    const amount = Math.floor(Number(req.body.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Số tiền không hợp lệ' })
    }
    const [minWithdraw, maxWithdraw] = await Promise.all([getMinWithdraw(), getMaxWithdraw()])
    if (amount < minWithdraw) {
      return res.status(400).json({ success: false, message: `Số tiền rút tối thiểu ${minWithdraw.toLocaleString('vi-VN')}đ` })
    }
    if (maxWithdraw > 0 && amount > maxWithdraw) {
      return res.status(400).json({ success: false, message: `Số tiền rút tối đa mỗi lần ${maxWithdraw.toLocaleString('vi-VN')}đ` })
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { payoutBankName: true, payoutBankNumber: true, payoutBankHolder: true },
    })
    if (!user.payoutBankName || !user.payoutBankNumber || !user.payoutBankHolder) {
      return res.status(400).json({ success: false, message: 'Vui lòng lưu thông tin ngân hàng trước khi rút', code: 'NO_BANK_INFO' })
    }

    const wr = await prisma.$transaction(async (tx) => {
      // Guard nguyên tử: chỉ trừ khi sellerBalance >= amount (chống rút vượt / song song)
      const deduct = await tx.user.updateMany({
        where: { id: req.user.id, sellerBalance: { gte: amount } },
        data: { sellerBalance: { decrement: amount } },
      })
      if (deduct.count === 0) { const e = new Error('INSUFFICIENT'); e.code = 'INSUFFICIENT'; throw e }
      return tx.withdrawalRequest.create({
        data: {
          userId: req.user.id,
          amount,
          bankName: user.payoutBankName,
          bankNumber: user.payoutBankNumber,
          bankHolder: user.payoutBankHolder,
          status: 'PENDING',
        },
      })
    })

    emitToAdmins('admin:new_withdrawal', { id: wr.id })
    res.json({ success: true, message: 'Đã gửi yêu cầu rút tiền, chờ admin xử lý', data: wr })
  } catch (e) {
    if (e.code === 'INSUFFICIENT') return res.status(400).json({ success: false, message: 'Số dư bán acc không đủ' })
    console.error('[createWithdrawal]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi tạo yêu cầu rút tiền' })
  }
}

// ── USER: huỷ yêu cầu khi còn PENDING -> hoàn lại sellerBalance ──────────────
const cancelWithdrawal = async (req, res) => {
  try {
    const { id } = req.params
    await prisma.$transaction(async (tx) => {
      const wr = await tx.withdrawalRequest.findFirst({ where: { id, userId: req.user.id } })
      if (!wr) { const e = new Error('NF'); e.code = 404; throw e }
      if (wr.status !== 'PENDING') { const e = new Error('BAD'); e.code = 400; throw e }
      await tx.withdrawalRequest.update({ where: { id }, data: { status: 'CANCELLED' } })
      await tx.user.update({ where: { id: req.user.id }, data: { sellerBalance: { increment: wr.amount } } })
    })
    res.json({ success: true, message: 'Đã huỷ yêu cầu và hoàn lại số dư bán acc' })
  } catch (e) {
    if (e.code === 404) return res.status(404).json({ success: false, message: 'Không tìm thấy yêu cầu' })
    if (e.code === 400) return res.status(400).json({ success: false, message: 'Chỉ huỷ được yêu cầu đang chờ xử lý' })
    console.error('[cancelWithdrawal]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi huỷ yêu cầu' })
  }
}

// ── ADMIN: danh sách yêu cầu rút ────────────────────────────────────────────
const adminListWithdrawals = async (req, res) => {
  try {
    const { status } = req.query
    const where = status ? { status } : {}
    const items = await prisma.withdrawalRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { user: { select: { id: true, username: true, displayName: true, email: true } } },
    })
    res.json({ success: true, data: items })
  } catch (e) {
    console.error('[adminListWithdrawals]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi tải danh sách rút tiền' })
  }
}

// ── ADMIN: xử lý -> PAID (đã chuyển khoản) hoặc REJECTED (hoàn tiền) ─────────
const adminProcessWithdrawal = async (req, res) => {
  try {
    const { id } = req.params
    const { action, note } = req.body // 'PAID' | 'REJECTED'
    if (!['PAID', 'REJECTED'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Hành động không hợp lệ' })
    }

    const result = await prisma.$transaction(async (tx) => {
      const wr = await tx.withdrawalRequest.findUnique({ where: { id } })
      if (!wr) { const e = new Error('NF'); e.code = 404; throw e }
      if (wr.status !== 'PENDING') { const e = new Error('BAD'); e.code = 400; throw e }
      const updated = await tx.withdrawalRequest.update({
        where: { id },
        data: { status: action, adminNote: note || null, processedBy: req.user.id, processedAt: new Date() },
      })
      // Từ chối -> hoàn lại tiền đã giữ chỗ
      if (action === 'REJECTED') {
        await tx.user.update({ where: { id: wr.userId }, data: { sellerBalance: { increment: wr.amount } } })
      }
      return updated
    })

    const amt = Number(result.amount).toLocaleString('vi-VN')
    await prisma.notification.create({
      data: {
        userId: result.userId,
        type: 'WITHDRAWAL',
        title: action === 'PAID' ? '💸 Rút tiền thành công' : 'Yêu cầu rút tiền bị từ chối',
        message: action === 'PAID'
          ? `Yêu cầu rút ${amt}đ đã được chuyển khoản.${note ? ' ' + note : ''}`
          : `Yêu cầu rút ${amt}đ bị từ chối, đã hoàn lại số dư bán acc.${note ? ' Lý do: ' + note : ''}`,
      },
    })
    emitToUser(result.userId, 'notification', { type: 'WITHDRAWAL' })
    emitToUser(result.userId, 'balance:update', {})

    res.json({
      success: true,
      message: action === 'PAID' ? 'Đã đánh dấu đã chuyển khoản' : 'Đã từ chối và hoàn tiền',
      data: result,
    })
  } catch (e) {
    if (e.code === 404) return res.status(404).json({ success: false, message: 'Không tìm thấy yêu cầu' })
    if (e.code === 400) return res.status(400).json({ success: false, message: 'Yêu cầu đã được xử lý trước đó' })
    console.error('[adminProcessWithdrawal]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi xử lý yêu cầu rút tiền' })
  }
}

// ── ADMIN: đọc / lưu cấu hình rút tiền (tối thiểu, tối đa) ───────────────────
const adminGetSettings = async (req, res) => {
  try {
    res.json({ success: true, data: { minWithdraw: await getMinWithdraw(), maxWithdraw: await getMaxWithdraw() } })
  } catch (e) {
    res.status(500).json({ success: false, message: 'Lỗi tải cấu hình' })
  }
}

const adminUpdateSettings = async (req, res) => {
  try {
    const { minWithdraw, maxWithdraw } = req.body
    const ops = []
    if (minWithdraw !== undefined) {
      const v = Math.floor(Number(minWithdraw))
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, message: 'Số tiền tối thiểu không hợp lệ' })
      ops.push(prisma.siteConfig.upsert({
        where: { key: 'withdraw_min_amount' },
        update: { value: String(v) },
        create: { key: 'withdraw_min_amount', value: String(v), group: 'withdrawal' },
      }))
    }
    if (maxWithdraw !== undefined) {
      const v = Math.floor(Number(maxWithdraw))
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ success: false, message: 'Số tiền tối đa không hợp lệ (0 = không giới hạn)' })
      ops.push(prisma.siteConfig.upsert({
        where: { key: 'withdraw_max_amount' },
        update: { value: String(v) },
        create: { key: 'withdraw_max_amount', value: String(v), group: 'withdrawal' },
      }))
    }
    await Promise.all(ops)
    res.json({ success: true, message: 'Đã lưu cấu hình rút tiền', data: { minWithdraw: await getMinWithdraw(), maxWithdraw: await getMaxWithdraw() } })
  } catch (e) {
    console.error('[adminUpdateSettings]', e.message)
    res.status(500).json({ success: false, message: 'Lỗi lưu cấu hình' })
  }
}

module.exports = {
  getMinWithdraw,
  getMaxWithdraw,
  updateBankInfo,
  getMyWithdrawInfo,
  createWithdrawal,
  cancelWithdrawal,
  adminListWithdrawals,
  adminProcessWithdrawal,
  adminGetSettings,
  adminUpdateSettings,
}
