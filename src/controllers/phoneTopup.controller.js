const crypto = require('crypto')
const axios = require('axios')
const prisma = require('../config/prisma')
const { emitToUser, emitToAdmins } = require('../config/socket')

// ══════════════════════════════════════════════════════════════════════════
// CẤU HÌNH — đối tác rechargews (nạp tiền điện thoại tự động)
// ══════════════════════════════════════════════════════════════════════════
const RC_URL        = process.env.PHONE_TOPUP_URL        || 'http://{{domain_post}}/api/rechargews'
const RC_PARTNER_ID = process.env.PHONE_TOPUP_PARTNER_ID || ''
const RC_PARTNER_KEY = process.env.PHONE_TOPUP_PARTNER_KEY || ''

const md5 = (...parts) => crypto.createHash('md5').update(parts.join('')).digest('hex')
const genRequestId = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`

// ══════════════════════════════════════════════════════════════════════════
// productlist của đối tác trả VỀ CHUNG cả thẻ game/dịch vụ số lẫn nạp điện thoại.
// Chỉ những service_code dưới đây mới là NẠP TIỀN ĐIỆN THOẠI thật (viễn thông).
// Đã đối chiếu trực tiếp với trang "Nạp Tiền Điện Thoại" của đối tác — họ CHỈ có
// đúng 3 sản phẩm này trong tính năng nạp thẳng (không cần mã thẻ, không cần OTP).
// Các mã có chữ "OTP" (viettelotp, myvina, myvinasmall, mobits) KHÔNG nằm trong
// tính năng này — không rõ luồng gọi (có thể cần thêm bước xác thực OTP mà lệnh
// "topup" hiện tại không hỗ trợ) nên tạm KHÔNG bật để tránh đơn bị treo/lỗi.
// Cập nhật danh sách này nếu đối tác xác nhận hỗ trợ thêm nhà mạng/loại nạp.
// ══════════════════════════════════════════════════════════════════════════
const TELCO_SERVICE_CODES = new Set([
  'viettelts',
  'vinatt',
  'myvinapass',
])

// Các mã trên không có mệnh giá cố định (đối tác trả value:1 = nhập số tiền tuỳ ý).
// Tự sinh bộ mệnh giá chuẩn để admin cấu hình/hiển thị cho user chọn.
// LƯU Ý: đối tác công bố ràng buộc thật trên web của họ (vd Vinaphone dùng mật khẩu:
// tối thiểu 20.000đ, tối đa 10.000.000đ, bội số 10.000đ) — bộ số dưới đây bám theo
// mốc tối thiểu 20.000đ để tránh tạo mệnh giá dưới ngưỡng đối tác cho phép.

const STANDARD_TELCO_DENOMS = [20000, 30000, 50000, 100000, 200000, 500000, 1000000]

// ══════════════════════════════════════════════════════════════════════════
// TẠO LỆNH NẠP — command "topup"
// Response mẫu: { status: "success", data: { order_code, pay_amount, discount,
//                 service_code, amount, status: "pending"|"success"|... } }
// LƯU Ý: "status" ở ngoài cùng là kết quả GỌI API (success/error — vd sai chữ ký,
// sai tham số...). "data.status" mới là trạng thái THẬT của đơn nạp
// (pending/success/failed). Hai cái khác nhau, không được gộp chung.
// ══════════════════════════════════════════════════════════════════════════
async function callProviderRecharge({ requestId, phone, serviceCode, amount, qty = 1 }) {
  const command = 'topup'
  const sign = md5(RC_PARTNER_KEY, RC_PARTNER_ID, command, requestId)

  const payload = {
    partner_id: RC_PARTNER_ID,
    command,
    request_id: requestId,
    service_code: serviceCode,
    amount: String(amount),
    qty: String(qty),
    account_info: { phone },
    sign,
  }

  const { data } = await axios.post(RC_URL, payload, {
    timeout: 20000,
    headers: { 'Content-Type': 'application/json' },
  })

  return data
}

async function callProviderGetStatus(orderCode, requestId) {
  const command = 'getstatus'
  const sign = md5(RC_PARTNER_KEY, RC_PARTNER_ID, command, requestId)

  const { data } = await axios.post(RC_URL, {
    partner_id: RC_PARTNER_ID,
    command,
    request_id: requestId,
    order_code: orderCode,
    sign,
  }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } })

  return data
}

async function callProviderProductList() {
  const command = 'productlist'
  const sign = md5(RC_PARTNER_KEY, RC_PARTNER_ID, command)

  const { data } = await axios.post(RC_URL, {
    partner_id: RC_PARTNER_ID,
    command,
    sign,
  }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } })

  return data
}

async function callProviderGetBalance() {
  const command = 'getbalance'
  const sign = md5(RC_PARTNER_KEY, RC_PARTNER_ID, command)

  const { data } = await axios.post(RC_URL, {
    partner_id: RC_PARTNER_ID,
    command,
    sign,
  }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } })

  return data
}

// map trạng thái trả về của getstatus/recharge -> enum nội bộ
const mapStatus = raw => {
  const s = String(raw || '').toLowerCase()
  if (s === 'success') return 'SUCCESS'
  if (s === 'pending' || s === 'processing') return 'PENDING'
  return 'FAILED'
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — Đồng bộ sản phẩm từ đối tác (productlist) vào PhoneTopupConfig
// ══════════════════════════════════════════════════════════════════════════
// Chạy các promise theo từng batch nhỏ để không mở quá nhiều connection DB cùng lúc
async function runInBatches(items, batchSize, worker) {
  const results = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    results.push(...(await Promise.all(batch.map(worker))))
  }
  return results
}

const adminSyncProducts = async (req, res) => {
  const t0 = Date.now()
  try {
    const apiRes = await callProviderProductList()
    const list = Array.isArray(apiRes?.data) ? apiRes.data : []
    console.log(`[adminSyncProducts] nhận ${list.length} nhóm sản phẩm từ đối tác sau ${Date.now() - t0}ms`)

    // Gom hết item cần sync thành 1 mảng phẳng
    // CHỈ lấy đúng các mã nạp điện thoại thật (TELCO_SERVICE_CODES) — productlist của
    // đối tác trả về chung cả thẻ game/dịch vụ số, không lọc sẽ bị lẫn hết vào đây.
    const flatItems = []
    for (const product of list) {
      const serviceCode = product.service_code
      if (!serviceCode || !TELCO_SERVICE_CODES.has(serviceCode)) continue

      const telcoLabel = product.name
      const telco = serviceCode.replace(/tt$|ts$|otp$/i, '').toUpperCase()
      const items = product.items || []

      // Dòng value<=1 chỉ là placeholder "nạp linh hoạt", không phải mệnh giá thật -> luôn bỏ qua.
      const realItems = items.filter(it => parseFloat(it.value) > 1)

      if (realItems.length === 0) {
        // Đối tác không cho mệnh giá cố định nào (toàn placeholder) -> tự sinh bộ mệnh giá chuẩn
        const providerDiscount = parseFloat(items[0]?.discount || 0)
        for (const denomination of STANDARD_TELCO_DENOMS) {
          flatItems.push({
            telco, telcoLabel, serviceCode, denomination,
            providerDiscount,
            thumbnailUrl: product.image || null,
          })
        }
      } else {
        for (const item of realItems) {
          const denomination = parseFloat(item.value)
          flatItems.push({
            telco, telcoLabel, serviceCode, denomination,
            providerDiscount: parseFloat(item.discount || 0),
            thumbnailUrl: product.image || null,
          })
        }
      }
    }
    console.log(`[adminSyncProducts] tổng ${flatItems.length} mệnh giá cần đồng bộ (đã lọc chỉ nạp điện thoại)`)

    // Đọc toàn bộ config hiện có TRONG 1 QUERY DUY NHẤT thay vì findUnique từng item
    const existedConfigs = await prisma.phoneTopupConfig.findMany({
      select: { id: true, serviceCode: true, denomination: true },
    })
    const existedMap = new Map(
      existedConfigs.map(c => [`${c.serviceCode}__${c.denomination}`, c.id])
    )

    let created = 0
    let updated = 0

    // Ghi song song theo batch (20 item/lần) thay vì tuần tự từng cái một
    await runInBatches(flatItems, 20, async item => {
      const key = `${item.serviceCode}__${item.denomination}`
      const existedId = existedMap.get(key)
      const data = { ...item, syncedAt: new Date() }

      if (existedId) {
        await prisma.phoneTopupConfig.update({ where: { id: existedId }, data })
        updated++
      } else {
        await prisma.phoneTopupConfig.create({
          data: { ...data, enabled: false, extraDiscount: 0 }, // mặc định tắt, admin tự bật sau khi kiểm tra
        })
        created++
      }
    })

    console.log(`[adminSyncProducts] xong sau ${Date.now() - t0}ms — ${created} mới, ${updated} cập nhật`)

    // ── Dọn dẹp config KHÔNG còn thuộc phạm vi lần sync này ─────────────────
    // Gồm: (a) mã dịch vụ không phải viễn thông (thẻ game cũ còn sót lại từ trước),
    //      (b) mệnh giá "rác" (vd dòng 1đ) không nằm trong danh sách vừa build.
    // Config nào ĐÃ CÓ đơn hàng thì chỉ tắt (enabled:false) để giữ lịch sử, không xoá.
    const targetKeys = new Set(flatItems.map(it => `${it.serviceCode}__${it.denomination}`))
    const staleConfigs = await prisma.phoneTopupConfig.findMany({
      where: {
        OR: [
          { serviceCode: { notIn: [...TELCO_SERVICE_CODES] } },
        ],
      },
      include: { _count: { select: { orders: true } } },
    })
    // Thêm các config viễn thông nhưng mệnh giá không còn hợp lệ (vd dòng 1đ cũ)
    const telcoConfigs = await prisma.phoneTopupConfig.findMany({
      where: { serviceCode: { in: [...TELCO_SERVICE_CODES] } },
      include: { _count: { select: { orders: true } } },
    })
    for (const c of telcoConfigs) {
      const key = `${c.serviceCode}__${c.denomination}`
      if (!targetKeys.has(key)) staleConfigs.push(c)
    }

    const staleIdsNoOrder = staleConfigs.filter(c => c._count.orders === 0).map(c => c.id)
    const staleIdsWithOrder = staleConfigs.filter(c => c._count.orders > 0).map(c => c.id)

    if (staleIdsNoOrder.length) {
      await prisma.phoneTopupConfig.deleteMany({ where: { id: { in: staleIdsNoOrder } } })
    }
    if (staleIdsWithOrder.length) {
      await prisma.phoneTopupConfig.updateMany({ where: { id: { in: staleIdsWithOrder } }, data: { enabled: false } })
    }
    console.log(`[adminSyncProducts] dọn dẹp: xoá ${staleIdsNoOrder.length}, tắt (có đơn cũ) ${staleIdsWithOrder.length}`)

    res.json({
      success: true,
      message: `Đồng bộ xong: ${created} mới, ${updated} cập nhật, đã dọn ${staleIdsNoOrder.length + staleIdsWithOrder.length} mục không còn phù hợp`,
      data: { created, updated, deleted: staleIdsNoOrder.length, disabled: staleIdsWithOrder.length },
    })
  } catch (e) {
    console.error('[adminSyncProducts ERROR]', e.response?.data || e.message)
    res.status(502).json({ success: false, message: 'Không lấy được danh sách sản phẩm từ đối tác: ' + (e.response?.data?.message || e.message) })
  }
}

const adminGetBalance = async (req, res) => {
  try {
    const apiRes = await callProviderGetBalance()
    res.json({ success: true, data: apiRes?.data || apiRes })
  } catch (e) {
    res.status(502).json({ success: false, message: 'Không lấy được số dư đối tác: ' + (e.response?.data?.message || e.message) })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ADMIN — Quản lý cấu hình (bật/tắt, chiết khấu, ảnh, thứ tự)
// ══════════════════════════════════════════════════════════════════════════
const adminGetConfigs = async (req, res) => {
  try {
    const configs = await prisma.phoneTopupConfig.findMany({
      orderBy: [{ sortOrder: 'asc' }, { telco: 'asc' }, { denomination: 'asc' }],
      include: { _count: { select: { orders: true } } },
    })
    res.json({ success: true, data: configs })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminUpdateConfig = async (req, res) => {
  try {
    const { id } = req.params
    const { enabled, extraDiscount, telcoLabel, sortOrder, thumbnailUrl } = req.body

    const data = {}
    if (enabled !== undefined) data.enabled = enabled === true || enabled === 'true'
    if (extraDiscount !== undefined) data.extraDiscount = parseFloat(extraDiscount)
    if (telcoLabel !== undefined) data.telcoLabel = telcoLabel
    if (sortOrder !== undefined) data.sortOrder = parseInt(sortOrder)
    if (req.file) data.thumbnailUrl = req.file.path
    else if (thumbnailUrl !== undefined) data.thumbnailUrl = thumbnailUrl

    const config = await prisma.phoneTopupConfig.update({ where: { id }, data })
    res.json({ success: true, data: config })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminGetOrders = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, phone, telco } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = {}
    if (status) where.status = status
    if (telco) where.telco = telco
    if (phone) where.phone = { contains: phone }

    const [items, total] = await Promise.all([
      prisma.phoneTopupOrder.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take: parseInt(limit),
        include: { user: { select: { username: true, displayName: true } } },
      }),
      prisma.phoneTopupOrder.count({ where }),
    ])

    res.json({ success: true, data: items, pagination: { page: parseInt(page), total, pages: Math.ceil(total / parseInt(limit)) } })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// Admin xử lý thủ công 1 đơn bị kẹt PENDING quá lâu (đối chiếu ngoài rồi quyết định)
const adminResolveOrder = async (req, res) => {
  try {
    const { id } = req.params
    const { status, note } = req.body // 'SUCCESS' | 'FAILED'

    if (!['SUCCESS', 'FAILED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ' })
    }

    const order = await prisma.phoneTopupOrder.findUnique({ where: { id }, include: { user: true } })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })
    if (order.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Đơn đã ở trạng thái ${order.status}` })
    }

    await _finalizeOrder(order, status, note || 'Admin xử lý thủ công')

    res.json({ success: true, message: 'Đã cập nhật' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC — danh sách gói cho user chọn
// ══════════════════════════════════════════════════════════════════════════
const getPublicConfigs = async (req, res) => {
  try {
    const configs = await prisma.phoneTopupConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { telco: 'asc' }, { denomination: 'asc' }],
      select: {
        id: true, telco: true, telcoLabel: true, serviceCode: true,
        denomination: true, extraDiscount: true, thumbnailUrl: true, sortOrder: true,
      },
    })
    res.json({ success: true, data: configs })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// USER — Tạo lệnh nạp tự động: chỉ cần sdt + mệnh giá, bấm là nạp thẳng
// ══════════════════════════════════════════════════════════════════════════
const VN_PHONE_REGEX = /^0\d{9}$/

const createTopupOrder = async (req, res) => {
  try {
    const { configId, phone } = req.body

    if (!configId || !phone) {
      return res.status(400).json({ success: false, message: 'Thiếu configId hoặc số điện thoại' })
    }

    const phoneClean = String(phone).trim().replace(/[\s.-]/g, '')
    if (!VN_PHONE_REGEX.test(phoneClean)) {
      return res.status(400).json({ success: false, message: 'Số điện thoại không hợp lệ' })
    }

    if (!RC_URL || !RC_PARTNER_ID || !RC_PARTNER_KEY) {
      return res.status(500).json({ success: false, message: 'Chưa cấu hình API nạp tiền điện thoại' })
    }

    const config = await prisma.phoneTopupConfig.findUnique({ where: { id: configId } })
    if (!config || !config.enabled) {
      return res.status(400).json({ success: false, message: 'Gói nạp này hiện không khả dụng' })
    }

    const denom = parseFloat(config.denomination)
    const discountRate = parseFloat(config.extraDiscount) / 100
    const price = Math.max(0, Math.round(denom * (1 - discountRate)))

    // Chống spam: quá nhiều đơn PENDING cùng SĐT trong thời gian ngắn
    const recentPending = await prisma.phoneTopupOrder.count({
      where: { phone: phoneClean, status: 'PENDING', createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
    })
    if (recentPending >= 2) {
      return res.status(429).json({ success: false, message: 'Số điện thoại này đang có lệnh nạp chờ xử lý, vui lòng đợi' })
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user || parseFloat(user.balance) < price) {
      return res.status(400).json({ success: false, message: `Số dư không đủ. Cần ${price.toLocaleString('vi-VN')}đ` })
    }

    const requestId = genRequestId()

    // Trừ tiền + tạo đơn PENDING trước khi gọi đối tác (đảm bảo không mất tiền nếu server crash giữa chừng)
    const order = await prisma.$transaction(async tx => {
      const updated = await tx.user.update({
        where: { id: req.user.id },
        data: { balance: { decrement: price }, totalSpent: { increment: price } },
      })

      const o = await tx.phoneTopupOrder.create({
        data: {
          userId: req.user.id,
          configId: config.id,
          requestId,
          phone: phoneClean,
          telco: config.telco,
          serviceCode: config.serviceCode,
          amount: denom,
          price,
          status: 'PENDING',
        },
      })

      await tx.transaction.create({
        data: {
          userId: req.user.id,
          type: 'PURCHASE',
          status: 'COMPLETED',
          amount: -price,
          balanceBefore: user.balance,
          balanceAfter: updated.balance,
          description: `Nạp tiền điện thoại ${config.telcoLabel || config.telco} ${denom.toLocaleString('vi-VN')}đ cho ${phoneClean}`,
          referenceId: o.id,
        },
      })

      emitToUser(req.user.id, 'balance:update', { balance: updated.balance })
      return o
    })

    let apiRes
    try {
      apiRes = await callProviderRecharge({ requestId, phone: phoneClean, serviceCode: config.serviceCode, amount: denom, qty: 1 })
    } catch (e) {
      console.error('[PHONE TOPUP API ERROR]', e.response?.data || e.message)
      await _finalizeOrder(order, 'FAILED', 'Lỗi kết nối nhà cung cấp')
      return res.status(502).json({ success: false, message: 'Lỗi kết nối nhà cung cấp, tiền đã được hoàn lại' })
    }

    // apiRes.status: kết quả gọi API (success/error). apiRes.data.status: trạng thái đơn thật.
    const orderCode = apiRes?.data?.order_code || null

    const status = apiRes.status !== 'success'
      ? 'FAILED' // gọi API thất bại ngay (sai chữ ký, sai tham số, hết hàng...)
      : mapStatus(apiRes?.data?.status)

    const providerMessage = apiRes.message || apiRes?.data?.message || null

    await prisma.phoneTopupOrder.update({
      where: { id: order.id },
      data: { orderCode, providerData: apiRes, message: providerMessage, lastCheckedAt: new Date() },
    })

    if (status === 'PENDING') {
      emitToAdmins('admin:new_phone_topup', { orderId: order.id, phone: phoneClean, amount: denom })
      return res.json({
        success: true,
        message: 'Đang nạp tiền, vui lòng chờ trong giây lát...',
        data: { id: order.id, status: 'PENDING', orderCode },
      })
    }

    await _finalizeOrder({ ...order, orderCode, providerData: apiRes }, status, providerMessage)

    const latestUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { balance: true } })

    return res.json({
      success: status === 'SUCCESS',
      message: status === 'SUCCESS' ? 'Nạp tiền thành công' : (providerMessage || 'Nạp tiền thất bại, tiền đã hoàn lại'),
      data: { id: order.id, status, newBalance: latestUser?.balance },
    })
  } catch (e) {
    console.error('[createTopupOrder ERROR]', e)
    res.status(500).json({ success: false, message: e.message || 'Lỗi nạp tiền điện thoại' })
  }
}

// User tự bấm "kiểm tra lại" cho đơn đang PENDING (đối tác không có callback -> phải poll getstatus)
const checkOrderStatus = async (req, res) => {
  try {
    const order = await prisma.phoneTopupOrder.findFirst({ where: { id: req.params.id, userId: req.user.id } })
    if (!order) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })

    if (order.status !== 'PENDING') {
      return res.json({ success: true, data: order })
    }
    if (!order.orderCode) {
      return res.json({ success: true, data: order, message: 'Đơn chưa có order_code từ đối tác' })
    }

    const apiRes = await callProviderGetStatus(order.orderCode, order.requestId)

    await prisma.phoneTopupOrder.update({
      where: { id: order.id },
      data: { providerData: apiRes, lastCheckedAt: new Date() },
    })

    // Chỉ chốt trạng thái khi API trả lời hợp lệ (status: success ở lớp ngoài).
    // Nếu lớp ngoài lỗi (mất kết nối, sai chữ ký tạm thời...) thì giữ nguyên PENDING, thử lại sau.
    if (apiRes.status === 'success' && apiRes?.data?.status) {
      const status = mapStatus(apiRes.data.status)
      if (status !== 'PENDING') {
        await _finalizeOrder(order, status, apiRes?.data?.message)
      }
    }

    const updated = await prisma.phoneTopupOrder.findUnique({ where: { id: order.id } })
    res.json({ success: true, data: updated })
  } catch (e) {
    console.error('[checkOrderStatus ERROR]', e.response?.data || e.message)
    res.status(500).json({ success: false, message: e.message })
  }
}

const getMyOrders = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query
    const where = { userId: req.user.id }
    if (status) where.status = status

    const [items, total] = await Promise.all([
      prisma.phoneTopupOrder.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit), take: parseInt(limit),
      }),
      prisma.phoneTopupOrder.count({ where }),
    ])

    res.json({ success: true, data: items, pagination: { page: parseInt(page), total, pages: Math.ceil(total / parseInt(limit)) } })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Nội bộ: chốt trạng thái đơn (hoàn tiền nếu FAILED) + báo realtime
// ══════════════════════════════════════════════════════════════════════════
async function _finalizeOrder(order, status, message) {
  await prisma.$transaction(async tx => {
    await tx.phoneTopupOrder.update({
      where: { id: order.id },
      data: { status, message: message || null },
    })

    if (status === 'FAILED') {
      const user = await tx.user.findUnique({ where: { id: order.userId } })
      const updated = await tx.user.update({
        where: { id: order.userId },
        data: { balance: { increment: order.price } },
      })

      await tx.transaction.create({
        data: {
          userId: order.userId,
          type: 'REFUND',
          status: 'COMPLETED',
          amount: parseFloat(order.price),
          balanceBefore: user.balance,
          balanceAfter: updated.balance,
          description: `Hoàn tiền nạp điện thoại thất bại: ${message || ''}`,
          referenceId: order.id,
        },
      })

      emitToUser(order.userId, 'balance:update', { balance: updated.balance })
    }

    await tx.notification.create({
      data: {
        userId: order.userId,
        type: status === 'SUCCESS' ? 'PURCHASE' : 'REFUND',
        title: status === 'SUCCESS' ? '✅ Nạp tiền điện thoại thành công' : '❌ Nạp tiền điện thoại thất bại',
        message: status === 'SUCCESS'
          ? `Đã nạp ${parseFloat(order.amount).toLocaleString('vi-VN')}đ cho ${order.phone}`
          : `${message || 'Nạp thất bại'} — đã hoàn ${parseFloat(order.price).toLocaleString('vi-VN')}đ`,
        data: { phoneTopupOrderId: order.id },
      },
    })
  })

  emitToUser(order.userId, 'phone_topup:result', { orderId: order.id, status, message })
  emitToAdmins('admin:phone_topup_update', { orderId: order.id, status })
}

// Gọi định kỳ (cron / setInterval) để tự dò các đơn PENDING quá cũ
async function pollPendingOrders() {
  const pendings = await prisma.phoneTopupOrder.findMany({
    where: {
      status: 'PENDING',
      orderCode: { not: null },
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // chỉ dò trong 1h gần nhất
    },
    take: 50,
  })

  for (const order of pendings) {
    try {
      const apiRes = await callProviderGetStatus(order.orderCode, order.requestId)
      await prisma.phoneTopupOrder.update({ where: { id: order.id }, data: { providerData: apiRes, lastCheckedAt: new Date() } })
      if (apiRes.status === 'success' && apiRes?.data?.status) {
        const status = mapStatus(apiRes.data.status)
        if (status !== 'PENDING') await _finalizeOrder(order, status, apiRes?.data?.message)
      }
    } catch (e) {
      console.error('[pollPendingOrders ERROR]', order.id, e.message)
    }
  }

  // Đơn PENDING quá 1h mà vẫn treo -> đánh dấu thất bại + hoàn tiền, để admin đối soát thủ công sau
  const stale = await prisma.phoneTopupOrder.findMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
    take: 50,
  })
  for (const order of stale) {
    await _finalizeOrder(order, 'FAILED', 'Quá thời gian xử lý, đã hoàn tiền — cần đối soát thủ công')
  }
}

module.exports = {
  adminSyncProducts,
  adminGetBalance,
  adminGetConfigs,
  adminUpdateConfig,
  adminGetOrders,
  adminResolveOrder,

  getPublicConfigs,
  createTopupOrder,
  checkOrderStatus,
  getMyOrders,

  pollPendingOrders,
}