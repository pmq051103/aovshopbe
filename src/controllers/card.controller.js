const crypto = require('crypto')
const axios = require('axios')
const prisma = require('../config/prisma')
const { deleteImage } = require('../config/cloudinary')
const { emitToUser, emitToAdmins } = require('../config/socket')
const { notifyUserCardPurchase } = require('../config/email')
const { getUserVipDiscounts, recalculateVip } = require('./vip.controller')
const { processReferralPurchase } = require('../services/affiliate.service')

// ── CHARGING: User nạp thẻ vào số dư ─────────────────────────────
const GT_URL = process.env.CARD_CHARGING_URL || 'https://thesieure.com/chargingws/v2'
const GT_PARTNER_ID = process.env.CARD_CHARGING_PARTNER_ID || ''
const GT_PARTNER_KEY = process.env.CARD_CHARGING_PARTNER_KEY || ''
const GT_CHARGING_WALLET_NUMBER = process.env.CARD_CHARGING_WALLET_NUMBER || ''

// ── CHECK: Kiểm tra seri thẻ đã sử dụng chưa (dùng chung tài khoản đối tác CHARGING
// vì đây là bước kiểm tra thẻ TRƯỚC/TRONG lúc khách nạp thẻ, cùng bối cảnh với charging) ──
const CARD_CHECK_URL = process.env.CARD_CHECK_URL || 'https://thesieure.com/api/checkcard'
const CARD_CHECK_PARTNER_ID = process.env.CARD_CHECK_PARTNER_ID || GT_PARTNER_ID
const CARD_CHECK_PARTNER_KEY = process.env.CARD_CHECK_PARTNER_KEY || GT_PARTNER_KEY

// ── SOFTCARD: User mua mã thẻ ───────────────────────────────────
// Theo doc mới: https://tenmien.com/api/cardws
const GT_BUY_URL = process.env.CARD_BUY_URL || 'https://thesieure.com/api/cardws'
const GT_BUY_PARTNER_ID = process.env.CARD_BUY_PARTNER_ID || ''
const GT_BUY_PARTNER_KEY = process.env.CARD_BUY_PARTNER_KEY || ''
const GT_BUY_WALLET_NUMBER = process.env.CARD_BUY_WALLET_NUMBER || ''

const md5 = (...parts) => crypto.createHash('md5').update(parts.join('')).digest('hex')
const genRequestId = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`

const mapDepositStatus = s =>
  s === 1 ? 'SUCCESS' : s === 2 ? 'WRONG_VALUE' : s === 3 ? 'FAILED' : s === 99 ? 'PENDING' : 'FAILED'

// ══════════════════════════════════════════════════════════════════════════
// ⚠️ LEGACY FALLBACK — KHÔNG dùng để gửi request cho đối tác nữa.
// Bảng này từng bị dùng để "đoán" service_code từ mã telco nội bộ, nhưng đối
// tác có thể đổi mã bất cứ lúc nào (vd VINAPHONE -> VINA, MOBIFONE -> MOBI,
// VIETNAMOBILE -> VNMOBILE) khiến bảng cứng này sai mà không ai biết, gửi
// nhầm service_code cho đối tác. Nguồn đúng duy nhất là field
// `CardConfig.serviceCode`, lấy trực tiếp từ API GET /products của đối tác
// (xem adminGetCardProducts) và lưu lại lúc tạo/sửa cấu hình.
// Bảng dưới đây CHỈ còn tác dụng cho các dòng cấu hình cũ tạo từ trước khi có
// field serviceCode (chưa được admin cập nhật lại) — dùng resolveServiceCode()
// bên dưới, không gọi trực tiếp bảng này ở chỗ khác.
// ══════════════════════════════════════════════════════════════════════════
const LEGACY_SERVICE_CODE_FALLBACK = {
  VIETTEL: 'Viettel',
  VINAPHONE: 'Vinaphone',
  MOBIFONE: 'Mobifone',
  VIETNAMOBILE: 'Vietnamobile',
  ZING: 'Zing',
  GARENA: 'Garena',
  VCOIN: 'Vcoin',
  GATE: 'Gate',
}
const REVERSE_SERVICE_CODE_MAP = Object.fromEntries(
  Object.entries(LEGACY_SERVICE_CODE_FALLBACK).map(([code, serviceCode]) => [serviceCode.toLowerCase(), code])
)

// ══════════════════════════════════════════════════════════════════════════
// ⚠️ QUAN TRỌNG: API NẠP THẺ (chargingws/v2) và API MUA THẺ (cardws) là 2 API
// KHÁC NHAU của cùng đối tác, và dùng 2 QUY ƯỚC MÃ TELCO KHÁC NHAU:
//   - cardws (MUA thẻ)  → service_code rút gọn: "Vina", "Mobi", "Vnmobile"...
//   - chargingws/v2 (NẠP thẻ) → tên ĐẦY ĐỦ viết hoa: "VIETTEL", "MOBIFONE"...
//     (xem doc chính thức: body mẫu dùng telco="MOBIFONE", response trả về
//     telco="VIETTEL")
// CardConfig.serviceCode được lấy từ cardws/products (dạng rút gọn) nên KHÔNG
// được dùng trực tiếp làm `telco` khi gọi chargingws/v2 — nếu không đối tác sẽ
// trả "Loại thẻ hoặc mệnh giá không tồn tại" dù thẻ hợp lệ. Bảng dưới đây map
// các dạng rút gọn phổ biến trong catalog cardws sang tên đầy đủ đúng chuẩn
// chargingws/v2 để tự sửa (self-heal) cho cả cấu hình cũ lẫn mới.
// ══════════════════════════════════════════════════════════════════════════
const CHARGING_TELCO_NORMALIZE = {
  VINA: 'VINAPHONE',
  MOBI: 'MOBIFONE',
  VNMOBILE: 'VIETNAMOBILE',
  VNMOBI: 'VIETNAMOBILE',
}

// Lấy mã telco ĐÚNG CHUẨN để gửi cho API NẠP THẺ (chargingws/v2).
// Ưu tiên chuẩn hoá từ config.telco (mã nội bộ) — KHÔNG dùng config.serviceCode
// vì đó là mã của API MUA thẻ (cardws), khác quy ước.
const resolveChargingTelco = config => {
  const raw = String(config.telco || '').toUpperCase().trim()
  const normalized = CHARGING_TELCO_NORMALIZE[raw] || raw

  if (normalized !== raw) {
    console.warn(
      `[CARD CHARGING] Tự động chuẩn hoá telco "${raw}" → "${normalized}" cho cấu hình id=${config.id} ` +
      `(mã rút gọn từ catalog cardws không dùng được cho chargingws/v2).`
    )
  }

  return normalized
}

// ══════════════════════════════════════════════════════════════════════════
// Danh sách mã telco + phí/phạt THẬT lấy từ API "giá tẩy thẻ" của đối tác
// (chargingws/price) — dùng để:
//  1) Biết chính xác danh sách mã hợp lệ hiện tại (không phải đoán/hardcode)
//  2) Tự cảnh báo nếu 1 cấu hình đang gửi mã KHÔNG có trong danh sách thật
// Có cache (TTL) để tránh gọi API đối tác trên mỗi lượt nạp thẻ — chỉ dùng để
// LOG CẢNH BÁO, không chặn/thay đổi luồng nạp thẻ nếu API này lỗi.
// ══════════════════════════════════════════════════════════════════════════
const CHARGING_PRICE_URL = process.env.CARD_CHARGING_PRICE_URL
  || `${GT_URL.replace(/\/chargingws\/v2\/?$/, '')}/chargingws/price`
const CHARGING_PRICE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 phút

let _chargingPriceCache = { data: null, fetchedAt: 0 }

const getChargingPriceList = async () => {
  const now = Date.now()
  if (_chargingPriceCache.data && (now - _chargingPriceCache.fetchedAt) < CHARGING_PRICE_CACHE_TTL_MS) {
    return _chargingPriceCache.data
  }

  try {
    const { data } = await axios.get(CHARGING_PRICE_URL, {
      params: { partner_id: GT_PARTNER_ID },
      timeout: 5000,
    })

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      _chargingPriceCache = { data, fetchedAt: now }
    }
  } catch (e) {
    console.warn(
      '[CARD CHARGING] Không lấy được danh sách giá/mã telco hợp lệ từ đối tác: ' +
      (e.response?.data?.message || e.message)
    )
  }

  return _chargingPriceCache.data
}

// Kiểm tra (không chặn luồng) xem mã telco đã chuẩn hoá có thực sự tồn tại
// trong danh sách thật của đối tác không — log cảnh báo sớm nếu lệch, để admin
// biết mà sửa cấu hình TRƯỚC KHI khách gặp lỗi hàng loạt với 1 loại thẻ.
const warnIfChargingTelcoInvalid = (chargingTelco, config) => {
  getChargingPriceList()
    .then(priceList => {
      if (!priceList) return // API lỗi hoặc chưa có cache — bỏ qua, không chặn gì
      if (!(chargingTelco in priceList)) {
        console.warn(
          `[CARD CHARGING] ⚠️ Mã telco "${chargingTelco}" (cấu hình id=${config.id}, telco nội bộ="${config.telco}") ` +
          `KHÔNG có trong danh sách mã hợp lệ hiện tại từ đối tác: [${Object.keys(priceList).join(', ')}]. ` +
          `Vào Admin > Cấu hình thẻ kiểm tra lại loại thẻ này.`
        )
      }
    })
    .catch(() => {}) // best-effort, không được làm ảnh hưởng luồng nạp thẻ chính
}

// Lấy service_code THẬT để gửi cho đối tác khi mua/nạp thẻ.
// Luôn ưu tiên config.serviceCode (lấy thẳng từ API /products của đối tác lúc tạo cấu hình).
// Chỉ khi cấu hình đó chưa có serviceCode (dòng cũ tạo trước khi có field này) mới
// tạm dùng bảng cứng LEGACY_SERVICE_CODE_FALLBACK — và luôn log cảnh báo để admin biết
// vào sửa lại cấu hình (chọn lại từ danh sách sản phẩm thật hoặc nhập tay đúng service_code).
const resolveServiceCode = config => {
  if (config.serviceCode && config.serviceCode.trim()) return config.serviceCode.trim()

  const fallback = LEGACY_SERVICE_CODE_FALLBACK[config.telco]
  console.warn(
    `[CARD] Cấu hình telco="${config.telco}" (id=${config.id}) chưa có serviceCode thật — ` +
    `đang tạm dùng fallback cứng "${fallback || config.telcoLabel || config.telco}". ` +
    `Vào Admin > Cấu hình thẻ, sửa lại telco này và chọn đúng service_code từ danh sách sản phẩm đối tác để tránh gửi sai.`
  )
  return fallback || config.telcoLabel || config.telco
}

// Lấy số dư ví bên đối tác (API mua thẻ) — hiển thị cho admin biết còn bao nhiêu tiền để mua thẻ cho khách
const adminGetCardBalance = async (req, res) => {
  try {
    if (!GT_BUY_URL || !GT_BUY_PARTNER_ID || !GT_BUY_PARTNER_KEY || !GT_BUY_WALLET_NUMBER) {
      return res.status(400).json({ success: false, message: 'Chưa cấu hình API mua thẻ hoặc thiếu CARD_BUY_WALLET_NUMBER' })
    }

    const command = 'getbalance'
    const sign = md5(GT_BUY_PARTNER_KEY, GT_BUY_PARTNER_ID, command)

    const { data } = await axios.post(GT_BUY_URL, null, {
      params: {
        partner_id: GT_BUY_PARTNER_ID,
        wallet_number: GT_BUY_WALLET_NUMBER,
        command,
        sign,
      },
      timeout: 10000,
    })

    res.json({ success: true, data: { balance: data.balance, currencyCode: data.currency_code || 'VND' } })
  } catch (e) {
    res.status(502).json({ success: false, message: 'Không lấy được số dư từ đối tác: ' + (e.response?.data?.message || e.message) })
  }
}

// Lấy danh sách thẻ + mệnh giá THẬT từ đối tác (GET /products) — dùng để admin chọn đúng loại thẻ,
// tránh trường hợp gõ tay telco/mệnh giá không tồn tại bên đối tác dẫn tới lỗi khi nạp/mua.
const adminGetCardProducts = async (req, res) => {
  try {
    const { data } = await axios.get(`${GT_BUY_URL}/products`, {
      params: { partner_id: GT_BUY_PARTNER_ID },
      timeout: 10000,
    })

    const rawList = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : [])

    const products = rawList.map(p => {
      const serviceCode = p.service_code || ''
      const scUpper = serviceCode.toUpperCase().replace(/\s+/g, '_')
      const telco = REVERSE_SERVICE_CODE_MAP[serviceCode.toLowerCase()]
        || CHARGING_TELCO_NORMALIZE[scUpper]
        || scUpper

      const denominations = (p.cardvalue || [])
        .map(cv => parseFloat(cv.value ?? cv.denomination ?? cv.face_value ?? cv.price ?? cv.mfaceValue))
        .filter(v => !isNaN(v) && v > 0)
        .sort((a, b) => a - b)

      return {
        telco,
        serviceCode,
        telcoLabel: (p.name || serviceCode || '').replace(/^Thẻ\s+/i, '').trim() || serviceCode,
        image: p.imgurl || p.image || null,
        denominations,
      }
    }).filter(p => p.telco && p.denominations.length > 0)

    res.json({ success: true, data: products })
  } catch (e) {
    res.status(502).json({ success: false, message: 'Không lấy được danh sách thẻ từ đối tác: ' + (e.response?.data?.message || e.message) })
  }
}

// Lấy danh sách mã telco + phí/phạt THẬT từ đối tác (API "giá tẩy thẻ"), kèm
// đối chiếu sẵn với các cấu hình hiện có để admin thấy ngay cấu hình nào đang
// lệch mã (không nằm trong danh sách hợp lệ thật của đối tác).
const adminGetChargingPriceList = async (req, res) => {
  try {
    // Bỏ qua cache khi admin chủ động vào xem, để luôn thấy dữ liệu mới nhất
    _chargingPriceCache = { data: null, fetchedAt: 0 }
    const priceList = await getChargingPriceList()

    if (!priceList) {
      return res.status(502).json({ success: false, message: 'Không lấy được danh sách giá/mã telco từ đối tác' })
    }

    const configs = await prisma.cardConfig.findMany({ select: { id: true, telco: true, telcoLabel: true } })
    const uniqueTelcos = [...new Map(configs.map(c => [c.telco, c])).values()]

    const mismatches = uniqueTelcos
      .map(c => ({ ...c, chargingTelco: resolveChargingTelco(c) }))
      .filter(c => !(c.chargingTelco in priceList))
      .map(c => ({ id: c.id, telco: c.telco, telcoLabel: c.telcoLabel, chargingTelco: c.chargingTelco }))

    res.json({ success: true, data: { priceList, mismatches } })
  } catch (e) {
    res.status(502).json({ success: false, message: 'Lỗi lấy danh sách giá/mã telco: ' + (e.response?.data?.message || e.message) })
  }
}


const adminGetConfigs = async (req, res) => {
  try {
    const configs = await prisma.cardConfig.findMany({
      orderBy: [{ sortOrder: 'asc' }, { telco: 'asc' }, { denomination: 'asc' }],
      include: { _count: { select: { purchases: true } } },
    })

    res.json({ success: true, data: configs })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminCreateConfig = async (req, res) => {
  try {
    const {
      telco,
      telcoLabel,
      serviceCode,
      denomination,
      depositEnabled,
      depositDiscount,
      buyEnabled,
      buyDiscount,
      sortOrder,
    } = req.body

    if (!telco || !denomination) {
      return res.status(400).json({ success: false, message: 'Thiếu telco hoặc mệnh giá' })
    }
    if (!serviceCode || !String(serviceCode).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu service_code — hãy chọn loại thẻ từ danh sách sản phẩm thật của đối tác (mục "Chọn nhanh"), hoặc nhập đúng service_code đối tác cung cấp.',
      })
    }

    const telcoKey = telco.toUpperCase().trim().replace(/\s+/g, '_')
    const denom = parseFloat(denomination)

    const existed = await prisma.cardConfig.findUnique({
      where: {
        telco_denomination: {
          telco: telcoKey,
          denomination: denom,
        },
      },
    })

    if (existed) {
      return res.status(400).json({ success: false, message: 'Cấu hình này đã tồn tại' })
    }

    const existingTelcoConfig = await prisma.cardConfig.findFirst({
      where: {
        telco: telcoKey,
        thumbnailUrl: { not: null },
      },
      select: {
        thumbnailUrl: true,
        thumbnailPublicId: true,
      },
    })

    const data = {
      telco: telcoKey,
      telcoLabel: telcoLabel?.trim() || telco.trim(),
      serviceCode: String(serviceCode).trim(),
      denomination: denom,
      depositEnabled: depositEnabled !== false && depositEnabled !== 'false',
      depositDiscount: parseFloat(depositDiscount ?? 27),
      buyEnabled: buyEnabled !== false && buyEnabled !== 'false',
      buyDiscount: parseFloat(buyDiscount ?? 10),
      sortOrder: parseInt(sortOrder ?? 0),
    }

    if (req.file) {
      data.thumbnailUrl = req.file.path
      data.thumbnailPublicId = req.file.filename
    } else if (existingTelcoConfig) {
      data.thumbnailUrl = existingTelcoConfig.thumbnailUrl
      data.thumbnailPublicId = existingTelcoConfig.thumbnailPublicId
    }

    const config = await prisma.cardConfig.create({ data })

    if (req.file) {
      await prisma.cardConfig.updateMany({
        where: {
          telco: telcoKey,
          id: { not: config.id },
        },
        data: {
          thumbnailUrl: data.thumbnailUrl,
          thumbnailPublicId: data.thumbnailPublicId,
        },
      })
    }

    res.status(201).json({ success: true, data: config })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// Tạo nhiều mệnh giá cùng lúc cho 1 telco (mỗi mệnh giá có chiết khấu riêng).
// Dòng nào đã tồn tại (trùng telco + mệnh giá) sẽ bị bỏ qua, không chặn các dòng còn lại.
// Body: { telco, telcoLabel, sortOrder, items: [{ denomination, depositEnabled, depositDiscount, buyEnabled, buyDiscount }] }
// File ảnh (nếu có) dùng chung cho tất cả mệnh giá thuộc telco này.
const adminBulkCreateConfig = async (req, res) => {
  try {
    const { telco, telcoLabel, serviceCode, sortOrder } = req.body
    let items = req.body.items

    if (!telco) return res.status(400).json({ success: false, message: 'Thiếu telco' })
    if (!serviceCode || !String(serviceCode).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu service_code — hãy chọn loại thẻ từ danh sách sản phẩm thật của đối tác, hoặc nhập đúng service_code đối tác cung cấp.',
      })
    }
    if (typeof items === 'string') {
      try { items = JSON.parse(items) } catch { items = [] }
    }
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ success: false, message: 'Cần ít nhất 1 mệnh giá' })

    const telcoKey = telco.toUpperCase().trim().replace(/\s+/g, '_')

    // Dùng ảnh mới upload, hoặc kế thừa ảnh đã có của telco này (nếu chưa có ảnh nào upload)
    const existingTelcoConfig = await prisma.cardConfig.findFirst({
      where: { telco: telcoKey, thumbnailUrl: { not: null } },
      select: { thumbnailUrl: true, thumbnailPublicId: true },
    })

    let thumbnailUrl = null
    let thumbnailPublicId = null
    if (req.file) {
      thumbnailUrl = req.file.path
      thumbnailPublicId = req.file.filename
    } else if (existingTelcoConfig) {
      thumbnailUrl = existingTelcoConfig.thumbnailUrl
      thumbnailPublicId = existingTelcoConfig.thumbnailPublicId
    }

    const created = []
    const skipped = []

    for (const item of items) {
      const denom = parseFloat(item.denomination)
      if (!denom || denom <= 0) {
        skipped.push({ denomination: item.denomination, reason: 'Mệnh giá không hợp lệ' })
        continue
      }

      const existed = await prisma.cardConfig.findUnique({
        where: { telco_denomination: { telco: telcoKey, denomination: denom } },
      })
      if (existed) {
        skipped.push({ denomination: denom, reason: 'Đã tồn tại' })
        continue
      }

      const config = await prisma.cardConfig.create({
        data: {
          telco: telcoKey,
          telcoLabel: telcoLabel?.trim() || telco.trim(),
          serviceCode: String(serviceCode).trim(),
          denomination: denom,
          depositEnabled: item.depositEnabled !== false && item.depositEnabled !== 'false',
          depositDiscount: parseFloat(item.depositDiscount ?? 27),
          buyEnabled: item.buyEnabled !== false && item.buyEnabled !== 'false',
          buyDiscount: parseFloat(item.buyDiscount ?? 10),
          sortOrder: parseInt(item.sortOrder ?? sortOrder ?? 0),
          thumbnailUrl,
          thumbnailPublicId,
        },
      })
      created.push(config)
    }

    // Nếu vừa upload ảnh mới, đồng bộ ảnh đó cho toàn bộ mệnh giá khác cùng telco (kể cả mệnh giá có từ trước)
    if (req.file && created.length > 0) {
      await prisma.cardConfig.updateMany({
        where: { telco: telcoKey, id: { notIn: created.map(c => c.id) } },
        data: { thumbnailUrl, thumbnailPublicId },
      })
    }

    res.status(201).json({
      success: true,
      message: `Đã tạo ${created.length} mệnh giá${skipped.length ? `, bỏ qua ${skipped.length} mệnh giá trùng/lỗi` : ''}`,
      data: { created, skipped },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminUpdateConfig = async (req, res) => {
  try {
    const {
      depositEnabled,
      depositDiscount,
      buyEnabled,
      buyDiscount,
      sortOrder,
      telco,
      telcoLabel,
      serviceCode,
      denomination,
    } = req.body

    const existing = await prisma.cardConfig.findUnique({
      where: { id: req.params.id },
    })

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    }

    const data = {}

    if (telco !== undefined) data.telco = telco.toUpperCase().trim().replace(/\s+/g, '_')
    if (telcoLabel !== undefined) data.telcoLabel = telcoLabel?.trim() || undefined
    if (serviceCode !== undefined) {
      const sc = String(serviceCode).trim()
      if (!sc) return res.status(400).json({ success: false, message: 'service_code không được để trống' })
      data.serviceCode = sc
    }
    if (denomination !== undefined) data.denomination = parseFloat(denomination)
    if (depositEnabled !== undefined) data.depositEnabled = depositEnabled === true || depositEnabled === 'true'
    if (depositDiscount !== undefined) data.depositDiscount = parseFloat(depositDiscount)
    if (buyEnabled !== undefined) data.buyEnabled = buyEnabled === true || buyEnabled === 'true'
    if (buyDiscount !== undefined) data.buyDiscount = parseFloat(buyDiscount)
    if (sortOrder !== undefined) data.sortOrder = parseInt(sortOrder)

    if (req.file) {
      if (existing.thumbnailPublicId) {
        const others = await prisma.cardConfig.count({
          where: {
            telco: existing.telco,
            thumbnailPublicId: existing.thumbnailPublicId,
            id: { not: existing.id },
          },
        })

        if (others === 0) {
          await deleteImage(existing.thumbnailPublicId).catch(() => { })
        }
      }

      data.thumbnailUrl = req.file.path
      data.thumbnailPublicId = req.file.filename

      const targetTelco = data.telco || existing.telco

      await prisma.cardConfig.updateMany({
        where: { telco: targetTelco },
        data: {
          thumbnailUrl: data.thumbnailUrl,
          thumbnailPublicId: data.thumbnailPublicId,
        },
      })
    }

    const config = await prisma.cardConfig.update({
      where: { id: req.params.id },
      data,
    })

    res.json({ success: true, data: config })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminDeleteConfig = async (req, res) => {
  try {
    const config = await prisma.cardConfig.findUnique({
      where: { id: req.params.id },
    })

    if (!config) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    }

    if (config.thumbnailPublicId) {
      const others = await prisma.cardConfig.count({
        where: {
          telco: config.telco,
          thumbnailPublicId: config.thumbnailPublicId,
          id: { not: config.id },
        },
      })

      if (others === 0) {
        await deleteImage(config.thumbnailPublicId).catch(() => { })
      }
    }

    await prisma.cardConfig.delete({
      where: { id: req.params.id },
    })

    res.json({ success: true, message: 'Đã xóa' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// Xoá NGUYÊN 1 loại thẻ (tất cả mệnh giá của telco đó) trong 1 lần — cho lẹ thay vì
// phải bấm xoá từng mệnh giá một. Nếu loại thẻ này đã có giao dịch nạp/mua liên kết tới
// (khoá ngoại cardConfigId) thì DB sẽ chặn xoá — báo lỗi rõ ràng để admin biết, thay vì
// để lỗi khoá ngoại thô hiện ra.
const adminDeleteConfigsByTelco = async (req, res) => {
  try {
    const { telco } = req.params

    const configs = await prisma.cardConfig.findMany({ where: { telco } })
    if (configs.length === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy loại thẻ này' })
    }

    // Thumbnail dùng chung cho cả nhóm telco -> chỉ cần xoá 1 lần
    const thumbnailPublicId = configs.find(c => c.thumbnailPublicId)?.thumbnailPublicId
    if (thumbnailPublicId) {
      await deleteImage(thumbnailPublicId).catch(() => { })
    }

    await prisma.cardConfig.deleteMany({ where: { telco } })

    res.json({ success: true, message: `Đã xóa ${configs.length} mệnh giá của loại thẻ này` })
  } catch (e) {
    // Lỗi khoá ngoại phổ biến nhất: loại thẻ này đã có lịch sử nạp/mua thẻ liên kết tới,
    // không xoá được vì sẽ làm mất dữ liệu giao dịch cũ của user.
    if (e.code === 'P2003' || /foreign key/i.test(e.message)) {
      return res.status(409).json({
        success: false,
        message: 'Không thể xoá — loại thẻ này đã có lịch sử nạp/mua liên quan. Hãy tắt "Cho phép nạp" / "Cho phép mua" ở từng mệnh giá thay vì xoá.',
      })
    }
    res.status(500).json({ success: false, message: e.message })
  }
}

// Sửa NGUYÊN 1 loại thẻ (áp dụng cùng lúc cho tất cả mệnh giá của telco đó) — cho lẹ
// thay vì phải bấm sửa từng mệnh giá một. Chỉ áp dụng field nào admin thực sự truyền lên;
// mệnh giá (denomination) và sortOrder KHÔNG sửa hàng loạt được (mỗi mệnh giá khác nhau),
// muốn đổi 2 field đó thì vẫn phải sửa từng dòng.
const adminUpdateConfigsByTelco = async (req, res) => {
  try {
    const { telco } = req.params
    const { telco: newTelcoRaw, telcoLabel, serviceCode, depositEnabled, depositDiscount, buyEnabled, buyDiscount } = req.body

    const configs = await prisma.cardConfig.findMany({ where: { telco } })
    if (configs.length === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy loại thẻ này' })
    }

    const data = {}

    // Đổi luôn MÃ TELCO cho cả nhóm (vd: nhập tay sai lúc đầu, giờ chọn lại đúng mã từ NCC).
    // Vì (telco, denomination) là unique, phải kiểm tra trùng trước khi đổi hàng loạt.
    if (newTelcoRaw !== undefined && newTelcoRaw !== '') {
      const newTelco = newTelcoRaw.toUpperCase().trim().replace(/\s+/g, '_')
      if (newTelco !== telco) {
        const existingUnderNew = await prisma.cardConfig.findMany({
          where: { telco: newTelco },
          select: { denomination: true }
        })
        const existingSet = new Set(existingUnderNew.map(c => c.denomination.toString()))
        const conflicts = configs.filter(c => existingSet.has(c.denomination.toString()))

        if (conflicts.length > 0) {
          return res.status(409).json({
            success: false,
            message: `Không thể đổi mã telco — "${newTelco}" đã có sẵn mệnh giá ${conflicts.map(c => Number(c.denomination).toLocaleString('vi-VN')).join('đ, ')}đ trùng lặp. Hãy xóa các mệnh giá trùng ở nhóm đích trước, hoặc sửa tay từng dòng.`
          })
        }

        data.telco = newTelco
      }
    }

    if (telcoLabel !== undefined && telcoLabel !== '') data.telcoLabel = telcoLabel.trim()
    if (serviceCode !== undefined && serviceCode !== '') data.serviceCode = String(serviceCode).trim()
    if (depositEnabled !== undefined) data.depositEnabled = depositEnabled === true || depositEnabled === 'true'
    if (depositDiscount !== undefined && depositDiscount !== '') data.depositDiscount = parseFloat(depositDiscount)
    if (buyEnabled !== undefined) data.buyEnabled = buyEnabled === true || buyEnabled === 'true'
    if (buyDiscount !== undefined && buyDiscount !== '') data.buyDiscount = parseFloat(buyDiscount)

    if (req.file) {
      const oldPublicId = configs.find(c => c.thumbnailPublicId)?.thumbnailPublicId
      if (oldPublicId) await deleteImage(oldPublicId).catch(() => { })
      data.thumbnailUrl = req.file.path
      data.thumbnailPublicId = req.file.filename
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Không có gì để cập nhật' })
    }

    await prisma.cardConfig.updateMany({ where: { telco }, data })

    res.json({ success: true, message: `Đã cập nhật ${configs.length} mệnh giá của loại thẻ này` })
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'Mã telco mới bị trùng mệnh giá với loại thẻ đích, không đổi được.' })
    }
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminDeleteConfigThumbnail = async (req, res) => {
  try {
    const config = await prisma.cardConfig.findUnique({
      where: { id: req.params.id },
    })

    if (!config) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    }

    if (config.thumbnailPublicId) {
      await deleteImage(config.thumbnailPublicId).catch(() => { })
    }

    await prisma.cardConfig.updateMany({
      where: { telco: config.telco },
      data: {
        thumbnailUrl: null,
        thumbnailPublicId: null,
      },
    })

    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminUpdateTelcoThumbnail = async (req, res) => {
  try {
    const telco = req.params.telco.toUpperCase()

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Thiếu file ảnh' })
    }

    const existing = await prisma.cardConfig.findFirst({
      where: {
        telco,
        thumbnailPublicId: { not: null },
      },
      select: {
        thumbnailPublicId: true,
      },
    })

    if (existing?.thumbnailPublicId) {
      await deleteImage(existing.thumbnailPublicId).catch(() => { })
    }

    await prisma.cardConfig.updateMany({
      where: { telco },
      data: {
        thumbnailUrl: req.file.path,
        thumbnailPublicId: req.file.filename,
      },
    })

    res.json({ success: true, thumbnailUrl: req.file.path })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminGetDeposits = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, telco, search } = req.query

    const where = {}

    if (status && status !== 'ALL') where.status = status
    if (telco && telco !== 'ALL') where.telco = telco

    if (search) {
      where.user = {
        OR: [
          { username: { contains: search } },
          { displayName: { contains: search } },
        ],
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)

    const [items, total] = await Promise.all([
      prisma.cardDeposit.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              username: true,
              displayName: true,
              avatar: true,
              email: true,
            },
          },
        },
      }),
      prisma.cardDeposit.count({ where }),
    ])

    res.json({
      success: true,
      data: items,
      pagination: {
        page: parseInt(page),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const adminGetPurchases = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, telco } = req.query

    const where = {}

    if (status && status !== 'ALL') where.status = status
    if (telco && telco !== 'ALL') where.telco = telco

    const skip = (parseInt(page) - 1) * parseInt(limit)

    const [items, total] = await Promise.all([
      prisma.cardPurchase.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              username: true,
              displayName: true,
              email: true,
            },
          },
          cardConfig: {
            select: {
              thumbnailUrl: true,
              telcoLabel: true,
            },
          },
        },
      }),
      prisma.cardPurchase.count({ where }),
    ])

    res.json({
      success: true,
      data: items,
      pagination: {
        page: parseInt(page),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC — Lấy danh sách cấu hình cho user
// ════════════════════════════════════════════════════════════════════════════

const getPublicConfigs = async (req, res) => {
  try {
    const { type } = req.query

    const where = {}

    if (type === 'deposit') where.depositEnabled = true
    else if (type === 'buy') where.buyEnabled = true
    else where.depositEnabled = true

    const configs = await prisma.cardConfig.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { telco: 'asc' }, { denomination: 'asc' }],
      select: {
        id: true,
        telco: true,
        telcoLabel: true,
        denomination: true,
        thumbnailUrl: true,
        depositEnabled: true,
        depositDiscount: true,
        buyEnabled: true,
        buyDiscount: true,
        sortOrder: true,
      },
    })

    res.json({ success: true, data: configs })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MESSAGE MAP
// ════════════════════════════════════════════════════════════════════════════

const translateCardMessage = (status, message, type = 'deposit') => {
  const msg = String(message || '').toUpperCase()
  const code = parseInt(status)

  if (msg.includes('API_FEE_TOO_LOW')) return 'Đã gửi thẻ lên hệ thống, đang chờ xử lý'
  if (msg.includes('INVALID_CARD')) return 'Thẻ không hợp lệ hoặc đã được sử dụng'
  if (msg.includes('INVALID_SIGNATURE')) return 'Sai chữ ký xác thực API'
  if (msg.includes('INVALID_PARTNER')) return 'Sai thông tin đối tác API'
  if (msg.includes('WRONG_VALUE')) return 'Thẻ sai mệnh giá'
  if (msg.includes('MAINTENANCE')) return 'Nhà cung cấp đang bảo trì'
  if (msg.includes('OUT_OF_STOCK')) return 'Loại thẻ này hiện đã hết hàng'
  if (msg.includes('NOT_ENOUGH')) return 'Số dư nhà cung cấp không đủ'
  if (msg.includes('CARD_NOT_FOUND')) return 'Không tìm thấy loại thẻ yêu cầu'
  if (msg.includes('INSUFFICIENT WALLET BALANCE')) return 'Số dư ví nhà cung cấp không đủ'

  if (type === 'buy') {
    switch (code) {
      case 1:
        return 'Mua thẻ thành công'
      case 2:
        return 'Thanh toán thành công nhưng lấy thẻ thất bại, vui lòng thử tải lại sau ít phút'
      case 100:
        return 'Sản phẩm không tồn tại'
      case 101:
        return 'Ví điện tử không tồn tại'
      case 102:
        return 'Số dư ví không đủ'
      case 103:
        return 'Không có dữ liệu gửi lên'
      case 104:
        return 'Dữ liệu gửi lên không đúng'
      case 105:
        return 'Sản phẩm không đúng'
      case 106:
        return 'Loại thẻ đang ngừng cung cấp'
      case 107:
        return 'Lỗi mua hàng, bạn chưa bị trừ tiền'
      case 108:
        return 'Không tồn tại tài khoản merchant'
      case 109:
        return 'Mã yêu cầu request_id đã tồn tại'
      case 110:
        return 'Yêu cầu không hợp lệ'
      case 111:
        return 'Địa chỉ ví không tồn tại'
      case 112:
        return 'Địa chỉ ví không hoạt động'
      case 113:
        return 'Tài khoản bị khóa'
      case 114:
        return 'Merchant sai IP đăng ký'
      case 115:
        return 'Merchant không hoạt động'
      case 116:
        return 'Sai chữ ký'
      case 117:
        return 'Yêu cầu không đúng, thiếu tham số command'
      case 118:
        return 'Sản phẩm này đã hết'
      case 119:
        return 'Địa chỉ IP không được quyền truy cập'
      case 120:
        return 'Lỗi hệ thống nhà cung cấp'
      case 121:
        return 'Thanh toán thất bại'
      case 122:
        return 'Không mua được hàng'
      case 123:
        return 'Giá sản phẩm không đúng'
      case 124:
        return 'Đơn hàng thất bại vì bị giới hạn'
      case 125:
        return 'Số lượng không hợp lệ'
      case 126:
        return 'Số lượng phải là số nguyên dương'
      default:
        return message || 'Mua thẻ thất bại'
    }
  }

  switch (code) {
    case 1:
      return 'Nạp thẻ thành công'
    case 2:
      return 'Thẻ sai mệnh giá, tiền đã được cộng theo giá trị thực'
    case 3:
      return 'Thẻ không hợp lệ hoặc đã được sử dụng'
    case 99:
      return 'Thẻ đang được xử lý'
    case 100:
      return message || 'Dữ liệu thẻ không hợp lệ'
    case 102:
      return 'Sai chữ ký xác thực API'
    default:
      return message || 'Có lỗi xảy ra khi xử lý thẻ'
  }
}

// ════════════════════════════════════════════════════════════════════════════
// NẠP THẺ CÀO
// ════════════════════════════════════════════════════════════════════════════

const depositCard = async (req, res) => {
  try {
    const { cardConfigId, code, serial } = req.body

    if (!cardConfigId || !code || !serial) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu thông tin thẻ'
      })
    }

    if (!GT_URL || !GT_PARTNER_ID || !GT_PARTNER_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Chưa cấu hình API nạp thẻ'
      })
    }

    const config = await prisma.cardConfig.findUnique({
      where: { id: cardConfigId }
    })

    if (!config || !config.depositEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Loại thẻ này hiện không hỗ trợ nạp'
      })
    }

    const failedCountLastHour = await prisma.cardDeposit.count({
      where: {
        userId: req.user.id,
        status: 'FAILED',
        createdAt: {
          gte: new Date(Date.now() - 3 * 60 * 60 * 1000),
        },
      },
    })

    if (failedCountLastHour >= 3) {
      return res.status(429).json({
        success: false,
        message: 'Bạn đã nhập sai thẻ quá nhiều lần. Vui lòng thử lại sau 3 giờ.',
      })
    }

    const codeClean = String(code).trim().replace(/[\s-]/g, '')
    const serialClean = String(serial).trim().replace(/[\s-]/g, '')
    const amount = parseInt(config.denomination)

    const existed = await prisma.cardDeposit.findFirst({
      where: {
        code: codeClean,
        serial: serialClean,
        status: {
          in: ['PENDING', 'SUCCESS', 'WRONG_VALUE']
        }
      }
    })

    if (existed) {
      return res.status(400).json({
        success: false,
        message: 'Thẻ này đã được nạp trước đó'
      })
    }

    const requestId = genRequestId()
    const sign = md5(
      GT_PARTNER_KEY,
      codeClean,
      serialClean
    )

    // ⚠️ QUAN TRỌNG: API NẠP THẺ (chargingws/v2) cần TÊN ĐẦY ĐỦ viết hoa
    // (VIETTEL, MOBIFONE, VINAPHONE...), KHÁC với config.serviceCode (dạng rút
    // gọn "Vina", "Mobi"... lấy từ API MUA thẻ/cardws). Gửi nhầm sẽ bị đối tác
    // trả lỗi "Loại thẻ hoặc mệnh giá không tồn tại" dù thẻ hoàn toàn hợp lệ.
    const chargingTelco = resolveChargingTelco(config)
    warnIfChargingTelcoInvalid(chargingTelco, config)

    const cardDeposit = await prisma.cardDeposit.create({
      data: {
        userId: req.user.id,
        cardConfigId: config.id,
        requestId,
        telco: config.telco,
        serviceCode: resolveServiceCode(config),
        code: codeClean,
        serial: serialClean,
        declaredAmount: amount,
        depositDiscount: config.depositDiscount,
        status: 'PENDING'
      }
    })

    const payload = {
      telco: chargingTelco,
      code: codeClean,
      serial: serialClean,
      amount: String(amount),
      request_id: requestId,
      partner_id: GT_PARTNER_ID,
      sign,
      command: 'charging'
    }

    console.log('[CARD CHARGING PAYLOAD]', {
      ...payload,
      code: '***',
      serial: '***',
      partner_key_exists: !!GT_PARTNER_KEY,
      wallet_number_exists: !!GT_CHARGING_WALLET_NUMBER
    })

    const { data: apiRes } = await axios.post(
      GT_URL,
      payload,
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    )

    console.log('[CARD CHARGING API RESPONSE]', apiRes)

    const apiStatus = parseInt(apiRes.status)
    const apiMessage = String(apiRes.message || '')
    const upperMessage = apiMessage.toUpperCase()

    const viMessage = translateCardMessage(
      apiStatus,
      apiMessage,
      'deposit'
    )

    // Chỉ các trạng thái thực sự đang xử lý mới chờ callback
    const shouldWaitCallback =
      apiStatus === 99 ||
      upperMessage.includes('API_FEE_TOO_LOW') ||
      upperMessage.includes('PENDING') ||
      upperMessage.includes('PROCESSING')

    if (shouldWaitCallback) {
      emitToAdmins('admin:new_card_deposit', { telco: config.telco, amount, userId: req.user.id })
      return res.json({
        success: true,
        message: viMessage,
        data: {
          id: cardDeposit.id,
          status: 'PENDING',
          requestId
        }
      })
    }

    // Các lỗi như:
    // Độ dài seri không hợp lệ
    // Sai mệnh giá
    // Sai mã thẻ
    // => xử lý luôn
    await _processDepositResult(cardDeposit, {
      ...apiRes,
      message: viMessage
    })

    const updated = await prisma.cardDeposit.findUnique({
      where: {
        id: cardDeposit.id
      }
    })

    return res.json({
      success: apiStatus === 1 || apiStatus === 2,
      message: viMessage,
      data: updated
    })
  } catch (e) {
    console.error(
      '[depositCard ERROR]',
      e.response?.data || e.message
    )

    return res.status(500).json({
      success: false,
      message:
        e.response?.data?.message ||
        e.message ||
        'Lỗi nạp thẻ'
    })
  }
}

const cardCallback = async (req, res) => {
  try {
    console.log('[CARD CALLBACK RECEIVED]', req.body)

    const { request_id, code, serial, callback_sign, sign } = req.body

    if (!request_id) {
      return res.json({ status: 200 })
    }

    const dep = await prisma.cardDeposit.findUnique({
      where: { requestId: String(request_id) },
    })

    if (!dep || dep.status !== 'PENDING') {
      return res.json({ status: 200 })
    }

    const providerSign = callback_sign || sign

    if (providerSign && code && serial) {
      const expectedSign = md5(
        GT_PARTNER_KEY,
        String(code).trim().replace(/[\s-]/g, ''),
        String(serial).trim().replace(/[\s-]/g, '')
      )

      if (providerSign !== expectedSign) {
        console.warn('[CARD CALLBACK INVALID SIGN]', {
          providerSign,
          expectedSign,
          request_id,
        })

        return res.json({ status: 200 })
      }
    }

    const viMessage = translateCardMessage(req.body.status, req.body.message, 'deposit')

    await _processDepositResult(dep, {
      ...req.body,
      message: viMessage,
    })

    return res.json({ status: 200 })
  } catch (e) {
    console.error('[cardCallback ERROR]', e)
    return res.json({ status: 200 })
  }
}

async function _processDepositResult(dep, apiRes) {
  const status = mapDepositStatus(parseInt(apiRes.status))

  const realAmount = parseFloat(
    apiRes.value ||
    apiRes.card_value ||
    apiRes.amount ||
    0
  )

  const viMessage = translateCardMessage(
    apiRes.status,
    apiRes.message,
    'deposit'
  )

  const discountRate = parseFloat(dep.depositDiscount) / 100

  const baseReceivedAmount =
    realAmount > 0
      ? Math.round(realAmount * (1 - discountRate))
      : 0

  const receivedAmount =
    status === 'WRONG_VALUE'
      ? Math.round(baseReceivedAmount * 0.4)
      : baseReceivedAmount

  await prisma.$transaction(async tx => {
    await tx.cardDeposit.update({
      where: { id: dep.id },
      data: {
        status,
        realAmount: realAmount || null,
        receivedAmount: receivedAmount || null,
        transId: String(apiRes.trans_id || ''),
        message: viMessage,
        callbackData: {
          ...apiRes,
          penaltyApplied: status === 'WRONG_VALUE',
          wrongValueRate: status === 'WRONG_VALUE' ? 0.4 : null,
          baseReceivedAmount,
          finalReceivedAmount: receivedAmount,
        },
      },
    })

    if ((status === 'SUCCESS' || status === 'WRONG_VALUE') && receivedAmount > 0) {
      const user = await tx.user.findUnique({
        where: { id: dep.userId },
      })

      const updated = await tx.user.update({
        where: { id: dep.userId },
        data: {
          balance: { increment: receivedAmount },
          totalDeposit: { increment: receivedAmount },
        },
      })

      await tx.transaction.create({
        data: {
          userId: dep.userId,
          type: 'DEPOSIT',
          status: 'COMPLETED',
          amount: receivedAmount,
          balanceBefore: user.balance,
          balanceAfter: updated.balance,
          description:
            status === 'WRONG_VALUE'
              ? `Nạp thẻ ${dep.telco} sai mệnh giá: thực ${realAmount.toLocaleString('vi-VN')}đ, nhận 40% sau chiết khấu`
              : `Nạp thẻ ${dep.telco} ${realAmount.toLocaleString('vi-VN')}đ`,
          referenceId: dep.id,
        },
      })

      // ── Cập nhật bảng xếp hạng ─────────────────────────────────────
      const now = new Date()
      const getWeek = date => {
        const onejan = new Date(date.getFullYear(), 0, 1)
        return Math.ceil((((date - onejan) / 86400000) + onejan.getDay() + 1) / 7)
      }
      const rankingPeriods = [
        { period: 'daily',   periodKey: `daily_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}` },
        { period: 'weekly',  periodKey: `weekly_${now.getFullYear()}_${getWeek(now)}` },
        { period: 'monthly', periodKey: `monthly_${now.getFullYear()}_${now.getMonth() + 1}` },
      ]
      for (const rp of rankingPeriods) {
        await tx.ranking.upsert({
          where: { userId_periodKey: { userId: dep.userId, periodKey: rp.periodKey } },
          update: { totalDeposit: { increment: receivedAmount } },
          create: { userId: dep.userId, period: rp.period, periodKey: rp.periodKey, totalDeposit: receivedAmount, totalSpent: 0 },
        })
      }

      emitToUser(dep.userId, 'balance:update', {
        balance: updated.balance,
      })

      emitToUser(dep.userId, 'card:deposit:result', {
        status,
        receivedAmount,
        message:
          status === 'WRONG_VALUE'
            ? `Thẻ sai mệnh giá, bạn nhận ${receivedAmount.toLocaleString('vi-VN')}đ (40% sau chiết khấu)`
            : viMessage,
      })

      emitToAdmins('admin:card_deposit_update', { depId: dep.id, userId: dep.userId, telco: dep.telco, amount: realAmount, status })

      await tx.notification.create({
        data: {
          userId: dep.userId,
          type: 'DEPOSIT',
          title:
            status === 'SUCCESS'
              ? 'Nạp thẻ thành công'
              : 'Thẻ sai mệnh giá',
          message:
            status === 'WRONG_VALUE'
              ? `${dep.telco} — thực ${realAmount.toLocaleString('vi-VN')}đ, nhận ${receivedAmount.toLocaleString('vi-VN')}đ`
              : `${dep.telco} — nhận ${receivedAmount.toLocaleString('vi-VN')}đ`,
          data: {
            cardDepositId: dep.id,
            realAmount,
            receivedAmount,
            penaltyApplied: status === 'WRONG_VALUE',
          },
        },
      })
    } else if (status === 'FAILED') {
      emitToUser(dep.userId, 'card:deposit:result', {
        status,
        message: viMessage,
      })

      emitToAdmins('admin:card_deposit_update', { depId: dep.id, userId: dep.userId, telco: dep.telco, status: 'FAILED' })

      await tx.notification.create({
        data: {
          userId: dep.userId,
          type: 'DEPOSIT',
          title: 'Nạp thẻ thất bại',
          message: viMessage,
          data: {
            cardDepositId: dep.id,
          },
        },
      })
    }
  })
}
async function markExpiredPendingDeposits(userId) {
  try {
    const expiredBefore = new Date(Date.now() - 3 * 60 * 1000)

    await prisma.cardDeposit.updateMany({
      where: {
        userId,
        status: 'PENDING',
        createdAt: {
          lt: expiredBefore,
        },
      },
      data: {
        status: 'FAILED',
        message: 'Thẻ quá thời gian xử lý',
      },
    })
  } catch (e) {
    console.error('[markExpiredPendingDeposits ERROR]', e)
  }
}

const getDepositHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, telco, fromDate, toDate } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    await markExpiredPendingDeposits(req.user.id)

    const where = { userId: req.user.id }
    if (status) where.status = status
    if (telco) where.telco = telco
    if (fromDate || toDate) {
      where.createdAt = {}
      if (fromDate) where.createdAt.gte = new Date(`${fromDate}T00:00:00.000Z`)
      if (toDate) where.createdAt.lte = new Date(`${toDate}T23:59:59.999Z`)
    }

    const [items, total] = await Promise.all([
      prisma.cardDeposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: {
          cardConfig: {
            select: {
              thumbnailUrl: true,
              telcoLabel: true,
            },
          },
        },
      }),
      prisma.cardDeposit.count({ where }),
    ])

    res.json({
      success: true,
      data: items,
      pagination: {
        page: parseInt(page),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message,
    })
  }
}

const getDepositStatus = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({
        success: false,
        message: 'Chưa đăng nhập',
      })
    }

    await markExpiredPendingDeposits(req.user.id)

    const dep = await prisma.cardDeposit.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      select: {
        id: true,
        userId: true,
        cardConfigId: true,
        requestId: true,
        telco: true,
        declaredAmount: true,
        realAmount: true,
        receivedAmount: true,
        depositDiscount: true,
        status: true,
        transId: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        cardConfig: {
          select: {
            thumbnailUrl: true,
            telcoLabel: true,
          },
        },
      },
    })

    if (!dep) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy giao dịch nạp thẻ',
      })
    }

    return res.json({
      success: true,
      data: dep,
    })
  } catch (e) {
    console.error('getDepositStatus error:', e)

    res.status(500).json({
      success: false,
      message: e.message || 'Lỗi lấy trạng thái nạp thẻ',
    })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MUA MÃ THẺ
// ════════════════════════════════════════════════════════════════════════════

const buyCard = async (req, res) => {
  try {
    const { cardConfigId, quantity = 1 } = req.body
    const qty = parseInt(quantity)

    if (!cardConfigId) {
      return res.status(400).json({ success: false, message: 'Thiếu cardConfigId' })
    }

    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      return res.status(400).json({ success: false, message: 'Số lượng 1–10 thẻ' })
    }

    if (!GT_BUY_URL || !GT_BUY_PARTNER_ID || !GT_BUY_PARTNER_KEY || !GT_BUY_WALLET_NUMBER) {
      return res.status(500).json({
        success: false,
        message: 'Chưa cấu hình API mua thẻ hoặc thiếu CARD_BUY_WALLET_NUMBER',
      })
    }

    const config = await prisma.cardConfig.findUnique({ where: { id: cardConfigId } })

    if (!config || !config.buyEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Loại thẻ này hiện không hỗ trợ mua',
      })
    }

    const denom = parseInt(config.denomination)

    // ── VIP discount cho mua thẻ (cộng dồn với buyDiscount sẵn có của loại thẻ) ──
    const { cardPercent: vipPercent, tier: vipTier } = await getUserVipDiscounts(req.user.id)
    const baseDiscountPercent = parseFloat(config.buyDiscount)
    const totalDiscountPercent = Math.min(100, Math.max(0, baseDiscountPercent + vipPercent))
    const unitPrice = Math.max(0, Math.round(denom * (1 - totalDiscountPercent / 100)))
    const totalPrice = unitPrice * qty

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })

    if (!user || parseFloat(user.balance) < totalPrice) {
      return res.status(400).json({
        success: false,
        message: `Số dư không đủ. Cần ${totalPrice.toLocaleString('vi-VN')}đ`,
      })
    }

    const requestId = genRequestId()
    const command = 'buycard'
    const sign = md5(GT_BUY_PARTNER_KEY, GT_BUY_PARTNER_ID, command, requestId)

    const purchase = await prisma.$transaction(async tx => {
      const updated = await tx.user.update({
        where: { id: req.user.id },
        data: { balance: { decrement: totalPrice }, totalSpent: { increment: totalPrice } },
      })

      const p = await tx.cardPurchase.create({
        data: {
          userId: req.user.id,
          cardConfigId: config.id,
          telco: config.telco,
          serviceCode: resolveServiceCode(config),
          denomination: denom,
          buyDiscount: totalDiscountPercent,
          unitPrice,
          quantity: qty,
          totalPrice,
          requestId,
          status: 'PENDING',
        },
      })

      await tx.transaction.create({
        data: {
          userId: req.user.id,
          type: 'PURCHASE',
          status: 'COMPLETED',
          amount: -totalPrice,
          balanceBefore: user.balance,
          balanceAfter: updated.balance,
          description: `Mua ${qty} thẻ ${config.telcoLabel || config.telco} ${denom.toLocaleString('vi-VN')}đ${vipPercent > 0 ? ` (VIP -${vipPercent}%)` : ''}`,
          referenceId: p.id,
        },
      })

      emitToUser(req.user.id, 'balance:update', { balance: updated.balance })

      return p
    })

    // Cập nhật VIP sau khi mua thẻ
    recalculateVip(req.user.id).catch(err => console.error('recalculateVip after card purchase:', err))

    // ⚠️ QUAN TRỌNG: gửi service_code THẬT của đối tác (config.serviceCode), KHÔNG tự
    // suy ra từ mã telco nội bộ — đó chính là nguyên nhân gây gửi sai mã cho đối tác.
    const serviceCode = resolveServiceCode(config)

    const payload = {
      partner_id: GT_BUY_PARTNER_ID,
      command,
      request_id: requestId,
      service_code: serviceCode,
      wallet_number: GT_BUY_WALLET_NUMBER,
      value: String(denom),
      qty: String(qty),
      sign,
    }

    console.log('[CARD BUY PAYLOAD]', {
      ...payload,
      sign,
      partner_key_exists: !!GT_BUY_PARTNER_KEY,
    })

    let apiRes
    try {
      const { data } = await axios.post(GT_BUY_URL, payload, {
        timeout: 25000,
        headers: { 'Content-Type': 'application/json' },
      })

      apiRes = data
      console.log('[CARD BUY API RESPONSE]', apiRes)
    } catch (e) {
      console.error('[CARD BUY API ERROR]', e.response?.data || e.message)

      await _refundPurchase(purchase, 'Lỗi kết nối nhà cung cấp')

      return res.status(502).json({
        success: false,
        message: 'Lỗi kết nối nhà cung cấp, tiền đã hoàn lại',
      })
    }

    const apiStatus = parseInt(apiRes.status)
    const viMessage = translateCardMessage(apiStatus, apiRes.message, 'buy')

    if (apiStatus === 1) {
      const cards = normalizeBuyCards(apiRes)

      // ✅ Mốc quan trọng nhất: thẻ đã mua thành công thật sự, đã lưu DB.
      // Từ đây trở xuống chỉ là các việc "phụ" (thông báo, email, hoa hồng CTV) —
      // TUYỆT ĐỐI không được để lỗi ở các bước phụ này làm gãy response trả về
      // FE, kẻo báo nhầm "thất bại" trong khi thẻ đã mua thành công.
      await prisma.cardPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'SUCCESS',
          cards,
          message: viMessage,
          providerData: apiRes,
        },
      })

      try {
        await prisma.notification.create({
          data: {
            userId: req.user.id,
            type: 'PURCHASE',
            title: 'Mua thẻ thành công',
            message: `${qty} thẻ ${config.telcoLabel || config.telco} ${denom.toLocaleString('vi-VN')}đ đã sẵn sàng`,
            data: {
              purchaseId: purchase.id,
            },
          },
        })
      } catch (e) {
        console.error('[buyCard notification ERROR — không ảnh hưởng kết quả mua thẻ]', e.message)
      }

      // Gửi email thông báo mua thẻ thành công
      try {
        const buyer = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true, displayName: true, username: true } })
        if (buyer?.email) {
          notifyUserCardPurchase({
            user: buyer,
            cards: cards || [],
            telco: config.telcoLabel || config.telco,
            denomination: denom,
            quantity: qty,
            totalPrice,
            purchaseId: purchase.id,
          }).catch(e => console.error('[Email card] error:', e.message))
        }
      } catch (e) {
        console.error('[buyCard email lookup ERROR — không ảnh hưởng kết quả mua thẻ]', e.message)
      }

      // Ghi nhận hoa hồng CTV nếu người mua được giới thiệu
      try {
        await processReferralPurchase(req.user.id, totalPrice, purchase.id)
      } catch (e) {
        console.error('[buyCard processReferralPurchase ERROR — không ảnh hưởng kết quả mua thẻ]', e.message)
      }

      let latestBalance = null
      try {
        const latestUser = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { balance: true },
        })
        latestBalance = latestUser?.balance
      } catch (e) {
        console.error('[buyCard latestUser lookup ERROR — không ảnh hưởng kết quả mua thẻ]', e.message)
      }

      return res.json({
        success: true,
        message: viMessage,
        data: {
          id: purchase.id,
          status: 'SUCCESS',
          cards,
          totalPrice,
          newBalance: latestBalance,
          telco: config.telco,
          telcoLabel: config.telcoLabel,
          denomination: denom,
          quantity: qty,
          thumbnailUrl: config.thumbnailUrl,
        },
      })
    }

    if (apiStatus === 2) {
      await prisma.cardPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'PENDING',
          message: viMessage,
          providerData: apiRes,
        },
      })

      try {
        await prisma.notification.create({
          data: {
            userId: req.user.id,
            type: 'PURCHASE',
            title: 'Đơn mua thẻ đang chờ lấy lại mã',
            message: viMessage,
            data: {
              purchaseId: purchase.id,
            },
          },
        })
      } catch (e) {
        console.error('[buyCard pending notification ERROR — không ảnh hưởng kết quả]', e.message)
      }

      return res.json({
        success: true,
        message: viMessage,
        data: {
          id: purchase.id,
          cards: [],
          totalPrice,
          status: 'PENDING',
        },
      })
    }

    await _refundPurchase(purchase, viMessage)

    return res.status(400).json({
      success: false,
      message: `${viMessage}, tiền đã hoàn lại`,
    })
  } catch (e) {
    console.error('[buyCard ERROR]', e)

    return res.status(500).json({
      success: false,
      message: e.message || 'Lỗi mua thẻ',
    })
  }
}

function normalizeBuyCards(apiRes) {
  if (Array.isArray(apiRes.cards)) return apiRes.cards
  if (Array.isArray(apiRes.data)) return apiRes.data

  if (apiRes.data && typeof apiRes.data === 'object') {
    return Array.isArray(apiRes.data.cards) ? apiRes.data.cards : [apiRes.data]
  }

  if (apiRes.card) return [apiRes.card]

  return []
}

async function _refundPurchase(purchase, reason) {
  try {
    const refundReason = reason || 'Mua thẻ thất bại'

    await prisma.$transaction(async tx => {
      await tx.cardPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'FAILED',
          message: refundReason,
        },
      })

      const user = await tx.user.findUnique({
        where: { id: purchase.userId },
      })

      const updated = await tx.user.update({
        where: { id: purchase.userId },
        data: {
          balance: { increment: purchase.totalPrice },
        },
      })

      await tx.transaction.create({
        data: {
          userId: purchase.userId,
          type: 'REFUND',
          status: 'COMPLETED',
          amount: parseFloat(purchase.totalPrice),
          balanceBefore: user.balance,
          balanceAfter: updated.balance,
          description: `Hoàn tiền mua thẻ: ${refundReason}`,
          referenceId: purchase.id,
        },
      })

      emitToUser(purchase.userId, 'balance:update', {
        balance: updated.balance,
      })

      await tx.notification.create({
        data: {
          userId: purchase.userId,
          type: 'REFUND',
          title: 'Hoàn tiền mua thẻ',
          message: `Đơn mua thẻ thất bại: ${refundReason}. Đã hoàn ${parseFloat(purchase.totalPrice).toLocaleString('vi-VN')}đ`,
          data: {
            purchaseId: purchase.id,
          },
        },
      })
    })
  } catch (e) {
    console.error('[refundPurchase ERROR]', e)
  }
}

const getBuyHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, telco, fromDate, toDate } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)

    const where = { userId: req.user.id }

    if (status) where.status = status
    if (telco) where.telco = telco

    if (fromDate || toDate) {
      where.createdAt = {}
      if (fromDate) where.createdAt.gte = new Date(`${fromDate}T00:00:00.000Z`)
      if (toDate) where.createdAt.lte = new Date(`${toDate}T23:59:59.999Z`)
    }

    const [items, total] = await Promise.all([
      prisma.cardPurchase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit),
        include: {
          cardConfig: {
            select: {
              thumbnailUrl: true,
              telcoLabel: true,
            },
          },
        },
      }),
      prisma.cardPurchase.count({ where }),
    ])

    res.json({
      success: true,
      data: items,
      pagination: {
        page: parseInt(page),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

const getBuyDetail = async (req, res) => {
  try {
    const p = await prisma.cardPurchase.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      include: {
        cardConfig: {
          select: {
            thumbnailUrl: true,
            telcoLabel: true,
          },
        },
      },
    })

    if (!p) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    }

    res.json({ success: true, data: p })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

// ── ADMIN: Cập nhật trạng thái nạp thẻ thủ công ──────────────────────────────
const adminUpdateDepositStatus = async (req, res) => {
  try {
    const { id } = req.params
    const { status, realAmount, note } = req.body
 
    const allowed = ['SUCCESS', 'WRONG_VALUE', 'FAILED']
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ' })
    }
 
    const dep = await prisma.cardDeposit.findUnique({ where: { id }, include: { user: true } })
    if (!dep) return res.status(404).json({ success: false, message: 'Không tìm thấy' })
    if (dep.status !== 'PENDING') {
      return res.status(400).json({ success: false, message: `Thẻ đã ở trạng thái ${dep.status}, không thể cập nhật` })
    }
 
    const discountRate = parseFloat(dep.depositDiscount) / 100
    const real = parseFloat(realAmount) || parseFloat(dep.declaredAmount)
 
    const baseReceived = Math.round(real * (1 - discountRate))
    const receivedAmount = status === 'WRONG_VALUE' ? Math.round(baseReceived * 0.4) : status === 'SUCCESS' ? baseReceived : 0
 
    await prisma.$transaction(async tx => {
      await tx.cardDeposit.update({
        where: { id },
        data: {
          status,
          realAmount: real,
          receivedAmount: receivedAmount || null,
          message: note || (status === 'SUCCESS' ? 'Admin xác nhận thủ công' : status === 'WRONG_VALUE' ? 'Sai mệnh giá — admin xác nhận' : 'Admin từ chối'),
        }
      })
 
      if ((status === 'SUCCESS' || status === 'WRONG_VALUE') && receivedAmount > 0) {
        const user = await tx.user.findUnique({ where: { id: dep.userId } })
        const updated = await tx.user.update({
          where: { id: dep.userId },
          data: { balance: { increment: receivedAmount }, totalDeposit: { increment: receivedAmount } }
        })
 
        await tx.transaction.create({
          data: {
            userId: dep.userId,
            type: 'DEPOSIT',
            status: 'COMPLETED',
            amount: receivedAmount,
            balanceBefore: user.balance,
            balanceAfter: updated.balance,
            description: status === 'WRONG_VALUE'
              ? `Nạp thẻ ${dep.telco} sai mệnh giá (admin duyệt thủ công): nhận ${receivedAmount.toLocaleString('vi-VN')}đ`
              : `Nạp thẻ ${dep.telco} (admin duyệt thủ công): nhận ${receivedAmount.toLocaleString('vi-VN')}đ`,
            referenceId: dep.id,
          }
        })
 
        await tx.notification.create({
          data: {
            userId: dep.userId,
            type: 'DEPOSIT',
            title: status === 'SUCCESS' ? '✅ Nạp thẻ thành công' : '⚠️ Thẻ sai mệnh giá',
            message: `${dep.telco} — nhận ${receivedAmount.toLocaleString('vi-VN')}đ`,
            data: { cardDepositId: dep.id, receivedAmount }
          }
        })
 
        emitToUser(dep.userId, 'balance:update', { balance: updated.balance })
        emitToUser(dep.userId, 'card:deposit:result', { status, receivedAmount, message: `Nạp thẻ ${status === 'WRONG_VALUE' ? 'sai mệnh giá' : 'thành công'}, nhận ${receivedAmount.toLocaleString('vi-VN')}đ` })
      } else if (status === 'FAILED') {
        await tx.notification.create({
          data: {
            userId: dep.userId,
            type: 'DEPOSIT',
            title: '❌ Nạp thẻ thất bại',
            message: note || `Thẻ ${dep.telco} không hợp lệ`,
            data: { cardDepositId: dep.id }
          }
        })
        emitToUser(dep.userId, 'card:deposit:result', { status: 'FAILED', message: note || 'Thẻ không hợp lệ' })
      }
    })
 
    emitToAdmins('admin:card_deposit_update', { depId: dep.id, userId: dep.userId, telco: dep.telco, status })
 
    res.json({ success: true, message: `Đã cập nhật trạng thái → ${status}` })
  } catch (e) {
    console.error('[adminUpdateDepositStatus ERROR]', e)
    res.status(500).json({ success: false, message: e.message })
  }
}
 
// ── ADMIN: Gửi thẻ thủ công cho đơn mua bị lỗi ───────────────────────────────
const adminResendPurchase = async (req, res) => {
  try {
    const { id } = req.params
    const { cards, note } = req.body
    // cards: [{serial, code, expireDate}]
 
    if (!cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ success: false, message: 'Cần cung cấp thông tin thẻ' })
    }
 
    const purchase = await prisma.cardPurchase.findUnique({ where: { id }, include: { user: true } })
    if (!purchase) return res.status(404).json({ success: false, message: 'Không tìm thấy đơn' })
    if (purchase.status === 'SUCCESS') {
      return res.status(400).json({ success: false, message: 'Đơn đã thành công rồi' })
    }
 
    await prisma.cardPurchase.update({
      where: { id },
      data: {
        status: 'SUCCESS',
        cards,
        message: note || 'Admin gửi thẻ thủ công',
      }
    })
 
    await prisma.notification.create({
      data: {
        userId: purchase.userId,
        type: 'PURCHASE',
        title: 'Mua thẻ thành công',
        message: `${purchase.telco} ${parseFloat(purchase.denomination).toLocaleString('vi-VN')}đ x${purchase.quantity} — Admin đã gửi thẻ`,
        data: { cardPurchaseId: purchase.id }
      }
    })
 
    emitToUser(purchase.userId, 'notification', {
      type: 'PURCHASE',
      title: 'Mua thẻ thành công',
      message: `Admin đã gửi thẻ ${purchase.telco} cho bạn`
    })
 
    res.json({ success: true, message: 'Đã gửi thẻ thủ công thành công' })
  } catch (e) {
    console.error('[adminResendPurchase ERROR]', e)
    res.status(500).json({ success: false, message: e.message })
  }
}
 
// ══════════════════════════════════════════════════════════════════════════
// ADMIN — Kiểm tra 1 seri thẻ cào đã được sử dụng hay chưa (trước khi duyệt
// nạp thủ công cho khách, tránh trường hợp khách gửi thẻ đã dùng để gian lận).
// POST http://.../api/checkcard?telco=...&serial=...&partner_id=...&sign=...
// LƯU Ý: dù là method POST nhưng tham số vẫn nằm trên query string (không phải JSON body).
// sign = md5(partner_key + serial) — khác các API khác, KHÔNG có partner_id trong chuỗi ký,
// chỉ ghép partner_key với serial.
// Response: { status: "success", data: { status: "checked", serial, card_status: "unavailable"|..., value, date_used, acc_charged } }
// ══════════════════════════════════════════════════════════════════════════
const adminCheckCardSerial = async (req, res) => {
  try {
    const { telco, serial } = req.query
    if (!telco || !serial) {
      return res.status(400).json({ success: false, message: 'Thiếu telco hoặc serial' })
    }
    if (!CARD_CHECK_PARTNER_ID || !CARD_CHECK_PARTNER_KEY) {
      return res.status(500).json({ success: false, message: 'Chưa cấu hình API kiểm tra thẻ (CARD_CHECK_PARTNER_ID/KEY)' })
    }

    const serialClean = String(serial).trim().replace(/[\s-]/g, '')
    const sign = md5(CARD_CHECK_PARTNER_KEY, serialClean)

    // Dùng chung tài khoản đối tác với CHARGING (chargingws/v2) nên cũng cần
    // chuẩn hoá về tên đầy đủ viết hoa, phòng trường hợp phía client gửi lên
    // dạng rút gọn của catalog cardws (vd "Vina" thay vì "VINAPHONE").
    const telcoNormalized = CHARGING_TELCO_NORMALIZE[String(telco).toUpperCase().trim()] || String(telco).toUpperCase().trim()

    const { data: apiRes } = await axios.post(CARD_CHECK_URL, null, {
      params: { telco: telcoNormalized, serial: serialClean, partner_id: CARD_CHECK_PARTNER_ID, sign },
      timeout: 15000,
    })

    if (apiRes?.status !== 'success') {
      return res.status(502).json({ success: false, message: apiRes?.message || 'Đối tác không kiểm tra được thẻ này' })
    }

    res.json({ success: true, data: apiRes.data })
  } catch (e) {
    console.error('[adminCheckCardSerial ERROR]', e.response?.data || e.message)
    res.status(502).json({ success: false, message: 'Lỗi kết nối API kiểm tra thẻ: ' + (e.response?.data?.message || e.message) })
  }
}

module.exports = {
  adminGetConfigs,
  adminGetCardProducts,
  adminGetCardBalance,
  adminCreateConfig,
  adminBulkCreateConfig,
  adminUpdateConfig,
  adminDeleteConfig,
  adminDeleteConfigsByTelco,
  adminUpdateConfigsByTelco,
  adminDeleteConfigThumbnail,
  adminUpdateTelcoThumbnail,
  adminGetDeposits,
  adminGetPurchases,
  adminUpdateDepositStatus,
  adminResendPurchase,
  adminCheckCardSerial,
  adminGetChargingPriceList,

  getPublicConfigs,

  depositCard,
  cardCallback,
  getDepositHistory,
  getDepositStatus,

  buyCard,
  getBuyHistory,
  getBuyDetail,
}