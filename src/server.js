require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const helmet = require('helmet')
const compression = require('compression')
const morgan = require('morgan')

const { initSocket } = require('./config/socket')
const { errorHandler, notFound } = require('./middleware/errorMiddleware')
const rateLimiter = require('./middleware/rateLimiter')
const logger = require('./config/logger')

const authRoutes = require('./routes/auth.routes')
const userRoutes = require('./routes/user.routes')
const accountRoutes = require('./routes/account.routes')
const bannerRoutes = require('./routes/banner.routes')
const wheelRoutes = require('./routes/wheel.routes')
const mysteryBoxCategoryRoutes = require('./routes/mysteryBoxCategory.routes')
const depositRoutes = require('./routes/deposit.routes')
const rankingRoutes = require('./routes/ranking.routes')
const adminRoutes = require('./routes/admin.routes')
const notificationRoutes = require('./routes/notification.routes')
const orderRoutes = require('./routes/order.routes')
const ticketRoutes = require('./routes/ticket.routes')
const couponRoutes = require('./routes/coupon.routes')
const settingsRoutes = require('./routes/settings.routes')
const auditLogRoutes = require('./routes/auditLog.routes')
const ownedAccountRoutes = require('./routes/ownedAccount.routes')
const topupRoutes = require('./routes/topup.routes')
const categoriesRoutes = require('./routes/category.routes')
const newsRoutes = require('./routes/news.routes')
const chatbotRoutes = require('./routes/chatbot.routes')
const announcementRoutes = require('./routes/announcement.routes')
const cardRoutes = require('./routes/card.routes')
const aiKnowledgeRoutes = require('./routes/aiKnowledge.routes')
const chatRoutes        = require('./routes/chat.routes')
const activityRoutes    = require('./routes/activity.routes')
const skinTemplateRoutes = require('./routes/skinTemplate.routes')
const { affiliateRouter, vipRouter, wishlistRouter, compareRouter, layawayRouter, installmentRouter } = require('./routes/features.routes')
const profileRoutes = require('./routes/profile.routes')
const badgeRoutes = require('./routes/badge.routes')
const auctionRoutes = require('./routes/auction.routes')
const marketplaceRoutes = require('./routes/marketplace.routes')
const phoneTopupRoutes = require('./routes/phoneTopup.routes')

const { isOriginAllowed } = require('./config/allowedOrigins')

const app = express()
const server = http.createServer(app)
const io = initSocket(server)
app.set('trust proxy', 1) 
app.set('io', io)

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS: ' + origin))
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH'],
  allowedHeaders: ['Content-Type','Authorization','x-refresh-token'],
}))
// M7: 50mb quá lớn cho JSON (mở đường DoS bộ nhớ). Hạ về 10mb — vẫn dư cho rich-text
// kèm ảnh base64. File thật (ảnh/banner) đi qua multer/Cloudinary, không qua body JSON.
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(cookieParser()) // đọc httpOnly cookie chứa refresh token (req.cookies)
app.use(compression())

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }))
}

app.use('/api/', rateLimiter.global)

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ── Sitemap động cho SEO — liệt kê trang tĩnh + acc đang bán + tin tức ──
app.get('/sitemap.xml', async (req, res) => {
  const SITE_URL = 'https://aovshop.id.vn'
  try {
    const [accounts, news] = await Promise.all([
      prisma.gameAccount.findMany({
        where: { status: 'AVAILABLE' },
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 5000,
      }),
      prisma.news.findMany({
        select: { slug: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 1000,
      }).catch(() => []),
    ])

    const staticUrls = [
      { loc: '/', priority: '1.0' },
      { loc: '/shop', priority: '0.9' },
      { loc: '/ranking', priority: '0.5' },
      { loc: '/news', priority: '0.6' },
      { loc: '/mystery-box', priority: '0.6' },
      { loc: '/lucky-wheel', priority: '0.5' },
      { loc: '/card-shop', priority: '0.6' },
      { loc: '/dau-gia', priority: '0.6' },
      { loc: '/cho-trao-doi', priority: '0.6' },
    ]

    const urlEntries = [
      ...staticUrls.map(u => `  <url>\n    <loc>${SITE_URL}${u.loc}</loc>\n    <priority>${u.priority}</priority>\n  </url>`),
      ...accounts.map(a => `  <url>\n    <loc>${SITE_URL}/shop/acc/${a.id}</loc>\n    <lastmod>${new Date(a.updatedAt).toISOString()}</lastmod>\n    <priority>0.8</priority>\n  </url>`),
      ...news.map(n => `  <url>\n    <loc>${SITE_URL}/news/${n.slug}</loc>\n    <lastmod>${new Date(n.updatedAt).toISOString()}</lastmod>\n    <priority>0.5</priority>\n  </url>`),
    ]

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries.join('\n')}\n</urlset>`

    res.header('Content-Type', 'application/xml')
    res.send(xml)
  } catch (err) {
    logger.error('[Sitemap] error:', err.message)
    res.status(500).header('Content-Type', 'application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>')
  }
})

app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/accounts', accountRoutes)
app.use('/api/banners', bannerRoutes)
app.use('/api/wheel', wheelRoutes)
app.use('/api/mystery-box', mysteryBoxCategoryRoutes)
app.use('/api/deposit', depositRoutes)
app.use('/api/ranking', rankingRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/tickets', ticketRoutes)
app.use('/api/coupons', couponRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/audit-logs', auditLogRoutes)
app.use('/api/owned-accounts', ownedAccountRoutes)
app.use('/api/topup', topupRoutes)
app.use('/api/categories', categoriesRoutes)
app.use('/api/news', newsRoutes)
app.use('/api/chatbot', chatbotRoutes)
app.use('/api/announcements', announcementRoutes)
app.use('/api/card', cardRoutes)
app.use('/api/phone-topup', phoneTopupRoutes)
app.use('/api/admin/ai-knowledge', aiKnowledgeRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/activity', activityRoutes)
app.use('/api/skin-templates', skinTemplateRoutes)
app.use('/api/affiliate', affiliateRouter)
app.use('/api/vip',       vipRouter)
app.use('/api/wishlist',  wishlistRouter)
app.use('/api/compare',   compareRouter)
app.use('/api/layaway',   layawayRouter)
app.use('/api/installment', installmentRouter)
app.use('/api/profile', profileRoutes)
app.use('/api/badges', badgeRoutes)
app.use('/api/auctions', auctionRoutes)
app.use('/api/marketplace', marketplaceRoutes)


app.use(notFound)
app.use(errorHandler)

const PORT = process.env.PORT || 5000
server.listen(PORT, () => logger.info(` Server running on port ${PORT} [${process.env.NODE_ENV}]`))

// ── Cron: Kiểm tra layaway hết hạn mỗi giờ ──────────────────────────────────
const { checkOverdueLayaways } = require('./controllers/layaway.controller')
// Chạy ngay khi khởi động
checkOverdueLayaways()
// Sau đó chạy mỗi 1 giờ
setInterval(checkOverdueLayaways, 60 * 60 * 1000)

// ── Cron: Đóng phiên đấu giá đã hết giờ, chốt người thắng ───────────────────
const { closeExpiredRooms } = require('./controllers/auction.controller')
// Chạy ngay khi khởi động (phòng trường hợp server restart giữa phiên)
closeExpiredRooms()
// Sau đó kiểm tra mỗi 15 giây để chốt đúng giờ (đấu giá cần realtime hơn layaway)
setInterval(closeExpiredRooms, 15 * 1000)

// ── Graceful shutdown ────────────────────────────────────────────────────────
const prisma = require('./config/prisma')

const shutdown = async (signal) => {
  logger.warn(`[${signal}] Shutting down gracefully...`)
  server.close(async () => {
    await prisma.$disconnect()
    logger.info('Server closed, DB disconnected.')
    process.exit(0)
  })
  // Force exit sau 10s nếu vẫn treo
  setTimeout(() => process.exit(1), 10000)
}

// Bắt lỗi async không được catch → tránh crash server
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', { reason: reason?.message || reason, stack: reason?.stack })
  // KHÔNG exit — chỉ log để debug
})

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', { message: err.message, stack: err.stack })
  // Với uncaughtException thì state có thể corrupt → restart có kiểm soát
  shutdown('uncaughtException')
})

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

module.exports = { app, server }