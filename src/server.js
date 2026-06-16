require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
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

const app = express()
const server = http.createServer(app)
const io = initSocket(server)
app.set('trust proxy', 1) 
app.set('io', io)

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true, methods: ['GET','POST','PUT','DELETE','PATCH'], allowedHeaders: ['Content-Type','Authorization','x-refresh-token'] }))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))
app.use(compression())

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }))
}

app.use('/api/', rateLimiter.global)

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

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


app.use(notFound)
app.use(errorHandler)

const PORT = process.env.PORT || 5000
server.listen(PORT, () => logger.info(` Server running on port ${PORT} [${process.env.NODE_ENV}]`))

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