const prisma = require('../config/prisma')
const axios = require('axios')
const { sanitizeRichText } = require('../utils/sanitizeRichText')

let settingsCache = null
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000

// ══════════════════════════════════════════════════════════════════════════
// TikTok share link (nút "Chia sẻ" / "Copy link" trong app hoặc web) ra RẤT
// NHIỀU dạng rút gọn khác nhau tuỳ nguồn: vm.tiktok.com/xxxx, m.tiktok.com/t/xxxx/,
// www.tiktok.com/t/xxxx/, m.tiktok.com/v/xxxx.html... — tất cả đều KHÔNG chứa sẵn
// videoId, phải đi theo redirect thật (HTTP 301/302) mới ra được link đầy đủ dạng
// tiktok.com/@user/video/<videoId>. Trình duyệt/JS ở FE không tự theo được vì
// TikTok chặn CORS, nên phải resolve ở phía SERVER ngay khi admin lưu cài đặt —
// lưu sẵn link đầy đủ vào DB, để FE lấy videoId và embed được bình thường.
//
// Thay vì liệt kê từng dạng rút gọn (dễ sót vì TikTok hay đổi định dạng),
// coi TẤT CẢ link tiktok.com KHÔNG khớp đúng dạng đầy đủ @user/video/<id>
// là "rút gọn" và cần resolve.
// ══════════════════════════════════════════════════════════════════════════
const TIKTOK_FULL_LINK_REGEX = /tiktok\.com\/@[\w.-]+\/video\/\d+/
const isTiktokLink = url => /tiktok\.com/.test(url)
const isTiktokShortLink = url => isTiktokLink(url) && !TIKTOK_FULL_LINK_REGEX.test(url)

const resolveTiktokShortUrl = async url => {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      validateStatus: () => true,
    })
    // axios lưu URL cuối cùng sau khi theo hết redirect ở đây (khác nhau giữa Node/browser build)
    const finalUrl = res.request?.res?.responseUrl || res.request?.responseURL
    return finalUrl || url
  } catch (e) {
    console.error('[resolveTiktokShortUrl] lỗi:', e.message)
    return url // resolve thất bại -> giữ nguyên link gốc thay vì làm hỏng cả request lưu settings
  }
}

// Chuẩn hoá 1 giá trị setting trước khi lưu — hiện chỉ áp dụng cho video_section_url
// (link rút gọn TikTok -> link đầy đủ) để FE tách được videoId khi embed.
const normalizeSettingValue = async (key, value) => {
  if (key === 'video_section_url' && value && isTiktokShortLink(String(value))) {
    return resolveTiktokShortUrl(String(value).trim())
  }
  return value
}

const getAll = async (req, res) => {
  try {
    const configs = await prisma.siteConfig.findMany({
      orderBy: [{ group: 'asc' }, { key: 'asc' }],
    })

    const grouped = {}

    configs.forEach(c => {
      if (!grouped[c.group]) grouped[c.group] = {}
      grouped[c.group][c.key] = c.value
    })

    res.json({
      success: true,
      data: configs,
      grouped,
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message,
    })
  }
}

const getPublic = async (req, res) => {
  try {
    const now = Date.now()

    const maintenanceConfig = await prisma.siteConfig.findUnique({
      where: { key: 'maintenance_mode' },
    })

    let data

    if (settingsCache && now - cacheTime < CACHE_TTL) {
      data = {
        ...settingsCache,
        maintenance_mode: maintenanceConfig?.value ?? 'false',
      }
    } else {
      const configs = await prisma.siteConfig.findMany({
        where: {
          group: {
            in: ['general', 'social', 'seo', 'homepage'],
          },
        },
      })

      data = {}

      configs.forEach(c => {
        data[c.key] = c.value
      })

      settingsCache = data
      cacheTime = now
    }

    res.json({
      success: true,
      data,
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message,
    })
  }
}

const upsertMany = async (req, res) => {
  try {
    let { settings } = req.body

    if (typeof settings === 'string') {
      settings = JSON.parse(settings)
    }

    if (!Array.isArray(settings)) {
      return res.status(400).json({
        success: false,
        message: 'settings phải là array'
      })
    }

    const logoFile = req.files?.site_logo?.[0]
    const faviconFile = req.files?.site_favicon?.[0]

    if (logoFile) {
      const logoSetting = settings.find(s => s.key === 'site_logo')
      if (logoSetting) {
        logoSetting.value = logoFile.path
      } else {
        settings.push({
          key: 'site_logo',
          value: logoFile.path,
          group: 'general',
          type: 'string'
        })
      }
    }

    if (faviconFile) {
      const faviconSetting = settings.find(s => s.key === 'site_favicon')
      if (faviconSetting) {
        faviconSetting.value = faviconFile.path
      } else {
        settings.push({
          key: 'site_favicon',
          value: faviconFile.path,
          group: 'general',
          type: 'string'
        })
      }
    }

    // Nếu admin dán link rút gọn TikTok vào video_section_url -> resolve thành link đầy
    // đủ trước khi lưu (chạy song song, không chặn các setting khác nếu 1 cái lỗi mạng).
    const normalizedSettings = await Promise.all(
      settings.map(async s => ({
        ...s,
        value: await normalizeSettingValue(s.key, s.value),
      }))
    )

    await prisma.$transaction(normalizedSettings.map(s =>
      prisma.siteConfig.upsert({
        where: { key: s.key },
        create: {
          key: s.key,
          // Setting kiểu 'richtext' (VD: thông báo bảo trì soạn bằng ReactQuill) được hiển thị
          // trực tiếp qua dangerouslySetInnerHTML cho khách xem — phải sanitize để chặn XSS
          value: s.type === 'richtext' ? sanitizeRichText(String(s.value ?? '')) : String(s.value ?? ''),
          type: s.type || 'string',
          group: s.group || 'general'
        },
        update: {
          value: s.type === 'richtext' ? sanitizeRichText(String(s.value ?? '')) : String(s.value ?? ''),
          type: s.type || 'string',
          group: s.group || 'general'
        }
      })
    ))

    settingsCache = null

    res.json({
      success: true,
      message: 'Lưu cài đặt thành công'
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const upsertOne = async (req, res) => {
  try {
    const { key, value, group = 'general', type = 'string' } = req.body
    const resolvedValue = await normalizeSettingValue(key, value)

    const config = await prisma.siteConfig.upsert({
      where: { key },
      create: {
        key,
        value: type === 'richtext' ? sanitizeRichText(String(resolvedValue)) : String(resolvedValue),
        group,
        type,
      },
      update: {
        value: type === 'richtext' ? sanitizeRichText(String(resolvedValue)) : String(resolvedValue),
      },
    })

    settingsCache = null

    res.json({
      success: true,
      data: config,
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message,
    })
  }
}

module.exports = {
  getAll,
  getPublic,
  upsertMany,
  upsertOne,
}