const { emitToUser, emitToAll } = require('../config/socket')
const { notifyAdminTopupOrder, notifyUserTopupCompleted } = require('../config/email')
const logger = require('../config/logger')

const prisma = require('../config/prisma')
const genCode = () => `TU-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2,5).toUpperCase()}`

// ── PUBLIC ──────────────────────────────────────────────────
const getPackages = async (req, res) => {
  try {
    const packages = await prisma.topupPackage.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    })
    res.json({ success: true, data: packages })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── USER: Create topup order (dual payment: MONEY or QUAN_HUY) ──
const createOrder = async (req, res) => {
  try {
    const { packageId, gamePlayerId, gameServer, note, paymentMethod = 'MONEY' } = req.body

    if (!packageId || !gamePlayerId?.trim())
      return res.status(400).json({ success: false, message: 'Thiếu packageId hoặc gamePlayerId' })

    if (!['MONEY','QUAN_HUY'].includes(paymentMethod))
      return res.status(400).json({ success: false, message: 'paymentMethod không hợp lệ (MONEY | QUAN_HUY)' })

    const pkg = await prisma.topupPackage.findUnique({ where: { id: packageId } })
    if (!pkg || !pkg.isActive)
      return res.status(404).json({ success: false, message: 'Gói nạp không tồn tại hoặc đã ngừng' })

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    const totalQH = pkg.quanHuyAmount + pkg.bonusQuanHuy

    // ── Kiểm tra số dư tuỳ phương thức ────────────────────────
    if (paymentMethod === 'MONEY') {
      if (parseFloat(user.balance) < parseFloat(pkg.price)) {
        return res.status(400).json({
          success: false,
          message: `Số dư tiền không đủ. Cần ${parseInt(pkg.price).toLocaleString('vi-VN')}đ`,
          required: pkg.price,
          balance: user.balance,
          quanHuyBalance: user.quanHuyBalance,
        })
      }
    } else {
      // QUAN_HUY — giá quy đổi bằng tổng quân huy nhận được (1 QH = 1000đ quy ước)
      // Thực tế: thanh toán bằng đúng quanHuyAmount (không tính bonus)
      const qhRequired = pkg.quanHuyAmount
      if (user.quanHuyBalance < qhRequired) {
        return res.status(400).json({
          success: false,
          message: `Quân Huy không đủ. Cần ${qhRequired.toLocaleString()} QH`,
          required: qhRequired,
          quanHuyBalance: user.quanHuyBalance,
          balance: user.balance,
        })
      }
    }

    const order = await prisma.$transaction(async tx => {
      let updatedUser

      if (paymentMethod === 'MONEY') {
        updatedUser = await tx.user.update({
          where: { id: req.user.id },
          data: { balance: { decrement: pkg.price } },
        })
      } else {
        // Trừ quanHuyAmount (không tính bonus vì dùng QH để trả)
        updatedUser = await tx.user.update({
          where: { id: req.user.id },
          data: { quanHuyBalance: { decrement: pkg.quanHuyAmount } },
        })
        // Log QH transaction
        await tx.quanHuyTransaction.create({
          data: {
            userId: req.user.id,
            amount: -pkg.quanHuyAmount,
            balanceBefore: user.quanHuyBalance,
            balanceAfter: user.quanHuyBalance - pkg.quanHuyAmount,
            type: 'TOPUP_PAY',
            description: `Thanh toán gói ${pkg.name} bằng ${pkg.quanHuyAmount} Quân Huy`,
            referenceId: null,
          },
        })
      }

      const newOrder = await tx.gameTopupOrder.create({
        data: {
          orderCode: genCode(),
          userId: req.user.id,
          packageId,
          gamePlayerId: gamePlayerId.trim(),
          gameServer: gameServer?.trim() || null,
          note: note?.trim() || null,
          quanHuyCost: totalQH,
          paymentMethod,
          pricePaid: paymentMethod === 'MONEY' ? pkg.price : null,
          quanHuyPaid: paymentMethod === 'QUAN_HUY' ? pkg.quanHuyAmount : 0,
          status: 'PENDING',
        },
        include: {
          package: true,
          user: { select: { id: true, username: true, displayName: true, email: true } },
        },
      })

      // Tạo transaction lịch sử cho cả 2 phương thức thanh toán
      if (paymentMethod === 'MONEY') {
        await tx.transaction.create({
          data: {
            userId: req.user.id,
            type: 'TOPUP_PURCHASE',
            amount: -parseFloat(pkg.price),
            balanceBefore: user.balance,
            balanceAfter: updatedUser.balance,
            description: `Mua gói nạp QH "${pkg.name}" — ${totalQH} Quân Huy`,
            referenceId: newOrder.id,
          },
        })
      } else {
        // Thanh toán bằng Quân Huy — ghi transaction với amount = 0 (không trừ số dư VND)
        // nhưng vẫn ghi vào lịch sử giao dịch để user thấy
        await tx.transaction.create({
          data: {
            userId: req.user.id,
            type: 'TOPUP_PURCHASE',
            amount: 0,
            balanceBefore: user.balance,
            balanceAfter: user.balance,
            description: `Mua gói nạp QH "${pkg.name}" — ${totalQH} Quân Huy (thanh toán bằng ${pkg.quanHuyAmount} QH)`,
            referenceId: newOrder.id,
          },
        })
      }

      await tx.notification.create({
        data: {
          userId: req.user.id,
          type: 'SYSTEM',
          title: '⚔️ Đơn nạp Quân Huy đã được tạo',
          message: `Đơn #${newOrder.orderCode} đang chờ xử lý. Thanh toán: ${paymentMethod === 'MONEY' ? `${parseInt(pkg.price).toLocaleString('vi-VN')}đ` : `${pkg.quanHuyAmount} Quân Huy`}`,
          data: { orderId: newOrder.id, orderCode: newOrder.orderCode },
        },
      })

      return newOrder
    })

    // Notify admin email async
    notifyAdminTopupOrder({ order, user, pkg, paymentMethod }).catch(e => logger.error('Email err:', e.message))

    // Realtime
    emitToAll('topup:new_order', {
      orderCode: order.orderCode,
      username: user.username,
      packageName: pkg.name,
      quanHuy: totalQH,
      paymentMethod,
    })

    res.status(201).json({
      success: true,
      message: 'Tạo đơn nạp Quân Huy thành công!',
      data: order,
    })
  } catch (e) {
    logger.error('createTopupOrder:', e.message)
    res.status(500).json({ success: false, message: e.message })
  }
}

// ── USER: My orders ─────────────────────────────────────────
const getMyOrders = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query
    const where = { userId: req.user.id }
    if (status) where.status = status
    const [orders, total] = await Promise.all([
      prisma.gameTopupOrder.findMany({
        where, skip: (parseInt(page)-1)*parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { package: true },
      }),
      prisma.gameTopupOrder.count({ where }),
    ])
    res.json({ success: true, data: orders, pagination: { page: parseInt(page), total } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN ───────────────────────────────────────────────────
const adminGetOrders = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search } = req.query
    const where = {}
    if (status) where.status = status
    if (search) where.OR = [
      { orderCode: { contains: search } },
      { gamePlayerId: { contains: search } },
      { user: { username: { contains: search } } },
    ]
    const [orders, total] = await Promise.all([
      prisma.gameTopupOrder.findMany({
        where, skip: (parseInt(page)-1)*parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          package: true,
          user: { select: { id:true, username:true, displayName:true, email:true, avatar:true, quanHuyBalance:true } },
        },
      }),
      prisma.gameTopupOrder.count({ where }),
    ])
    res.json({ success: true, data: orders, pagination: { page: parseInt(page), total, pages: Math.ceil(total/parseInt(limit)) } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminCompleteOrder = async (req, res) => {
  try {
    const { adminNote } = req.body
    const order = await prisma.gameTopupOrder.findUnique({
      where: { id: req.params.id },
      include: { package: true, user: true },
    })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    if (!['PENDING','PROCESSING'].includes(order.status))
      return res.status(400).json({ success: false, message: 'Không thể hoàn thành đơn này' })

    const totalQH = order.package.quanHuyAmount + order.package.bonusQuanHuy

    await prisma.$transaction(async tx => {
      const updatedUser = await tx.user.update({
        where: { id: order.userId },
        data: { quanHuyBalance: { increment: totalQH } },
      })
      await tx.gameTopupOrder.update({
        where: { id: order.id },
        data: { status:'COMPLETED', completedAt: new Date(), adminNote: adminNote||null, processedBy: req.user.username },
      })
      await tx.quanHuyTransaction.create({
        data: {
          userId: order.userId,
          amount: totalQH,
          balanceBefore: order.user.quanHuyBalance,
          balanceAfter: order.user.quanHuyBalance + totalQH,
          type: 'TOPUP_RECEIVE',
          description: `Nhận ${totalQH} QH từ gói "${order.package.name}"`,
          referenceId: order.id,
        },
      })
      await tx.notification.create({
        data: {
          userId: order.userId, type: 'REWARD',
          title: '⚔️ Nạp Quân Huy thành công!',
          message: `Bạn nhận được ${totalQH} Quân Huy từ gói ${order.package.name}`,
          data: { orderId: order.id, quanHuy: totalQH },
        },
      })
    })

    emitToUser(order.userId, 'topup:completed', { orderCode: order.orderCode, quanHuy: totalQH })
    emitToUser(order.userId, 'balance:update', {})
    notifyUserTopupCompleted({ order, user: order.user, pkg: order.package, totalQuanHuy: totalQH })
      .catch(e => logger.error('User email:', e.message))

    res.json({ success: true, message: 'Hoàn thành đơn nạp Quân Huy' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminCancelOrder = async (req, res) => {
  try {
    const { adminNote } = req.body
    const order = await prisma.gameTopupOrder.findUnique({
      where: { id: req.params.id },
      include: { package: true, user: true },
    })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    if (!['PENDING','PROCESSING'].includes(order.status))
      return res.status(400).json({ success: false, message: 'Không thể hủy' })

    await prisma.$transaction(async tx => {
      // Hoàn lại theo phương thức đã dùng
      if (order.paymentMethod === 'MONEY' && order.pricePaid) {
        const updatedUser = await tx.user.update({
          where: { id: order.userId },
          data: { balance: { increment: order.pricePaid } },
        })
        await tx.transaction.create({
          data: {
            userId: order.userId, type: 'REFUND',
            amount: parseFloat(order.pricePaid),
            balanceBefore: order.user.balance,
            balanceAfter: parseFloat(order.user.balance) + parseFloat(order.pricePaid),
            description: `Hoàn tiền đơn nạp QH #${order.orderCode}`,
            referenceId: order.id,
          },
        })
      } else if (order.paymentMethod === 'QUAN_HUY' && order.quanHuyPaid) {
        await tx.user.update({
          where: { id: order.userId },
          data: { quanHuyBalance: { increment: order.quanHuyPaid } },
        })
        await tx.quanHuyTransaction.create({
          data: {
            userId: order.userId,
            amount: order.quanHuyPaid,
            balanceBefore: order.user.quanHuyBalance,
            balanceAfter: order.user.quanHuyBalance + order.quanHuyPaid,
            type: 'REFUND',
            description: `Hoàn ${order.quanHuyPaid} QH — đơn #${order.orderCode} bị hủy`,
            referenceId: order.id,
          },
        })
      }

      await tx.gameTopupOrder.update({
        where: { id: order.id },
        data: { status:'CANCELLED', cancelledAt: new Date(), adminNote: adminNote||'Admin hủy', processedBy: req.user.username },
      })
      await tx.notification.create({
        data: {
          userId: order.userId, type: 'SYSTEM',
          title: '↩️ Đơn nạp Quân Huy bị hủy',
          message: `Đơn #${order.orderCode} đã bị hủy. ${order.paymentMethod==='MONEY'?'Tiền đã hoàn lại.':'Quân Huy đã hoàn lại.'}`,
          data: { orderId: order.id },
        },
      })
    })

    emitToUser(order.userId, 'notification', { type: 'SYSTEM', title: `↩️ Đơn #${order.orderCode} bị hủy` })
    res.json({ success: true, message: 'Đã hủy và hoàn lại' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminProcessOrder = async (req, res) => {
  try {
    await prisma.gameTopupOrder.updateMany({
      where: { id: req.params.id, status: 'PENDING' },
      data: { status: 'PROCESSING', processedBy: req.user.username },
    })
    res.json({ success: true })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN: CRUD Packages ─────────────────────────────────────
const adminGetPackages = async (req, res) => {
  try {
    const packages = await prisma.topupPackage.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { orders: true } } },
    })
    res.json({ success: true, data: packages })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminCreatePackage = async (req, res) => {
  try {
    const { name, description, quanHuyAmount, bonusQuanHuy, price, isActive, sortOrder, isBestValue, isPopular, imageUrl } = req.body
    const pkg = await prisma.topupPackage.create({
      data: {
        name, description,
        imageUrl: req.file?.path || imageUrl,
        imagePublicId: req.file?.filename,
        quanHuyAmount: parseInt(quanHuyAmount),
        bonusQuanHuy: parseInt(bonusQuanHuy||0),
        price: parseFloat(price),
        isActive: isActive==='true'||isActive===true,
        sortOrder: parseInt(sortOrder||0),
        isBestValue: isBestValue==='true'||isBestValue===true,
        isPopular: isPopular==='true'||isPopular===true,
      },
    })
    res.status(201).json({ success: true, data: pkg })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminUpdatePackage = async (req, res) => {
  try {
    const data = { ...req.body }
    if (req.file) { data.imageUrl = req.file.path; data.imagePublicId = req.file.filename }
    for (const n of ['quanHuyAmount','bonusQuanHuy','sortOrder']) if (data[n]!==undefined) data[n]=parseInt(data[n])
    if (data.price) data.price = parseFloat(data.price)
    for (const b of ['isActive','isBestValue','isPopular']) if (data[b]!==undefined) data[b]=data[b]==='true'||data[b]===true
    const pkg = await prisma.topupPackage.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: pkg })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminDeletePackage = async (req, res) => {
  try {
    await prisma.topupPackage.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa gói nạp' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = {
  getPackages, createOrder, getMyOrders,
  adminGetOrders, adminCompleteOrder, adminCancelOrder, adminProcessOrder,
  adminGetPackages, adminCreatePackage, adminUpdatePackage, adminDeletePackage,
}