const prisma = require('../config/prisma')
const { sanitizeRichText } = require('../utils/sanitizeRichText')

let settingsCache = null
let cacheTime = 0
const CACHE_TTL = 5 * 60 * 1000

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

    await prisma.$transaction(settings.map(s =>
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

    const config = await prisma.siteConfig.upsert({
      where: { key },
      create: {
        key,
        value: type === 'richtext' ? sanitizeRichText(String(value)) : String(value),
        group,
        type,
      },
      update: {
        value: type === 'richtext' ? sanitizeRichText(String(value)) : String(value),
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