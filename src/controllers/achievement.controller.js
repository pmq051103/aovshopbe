const prisma = require('../config/prisma')
const { emitToUser } = require('../config/socket')

// ── Public / User ─────────────────────────────────────────────────────────
const getAllAchievements = async (req, res) => {
  try {
    const achievements = await prisma.achievement.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: { rewardBadge: true }
    })
    res.json({ success: true, data: achievements })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Trả về toàn bộ thành tựu kèm trạng thái đã đạt/chưa đạt + tiến độ hiện tại của user
const getMyAchievements = async (req, res) => {
  try {
    const userId = req.user.id
    const [achievements, mine, metrics] = await Promise.all([
      prisma.achievement.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, include: { rewardBadge: true } }),
      prisma.userAchievement.findMany({ where: { userId } }),
      computeUserMetrics(userId)
    ])

    const achievedIds = new Set(mine.map(m => m.achievementId))
    const achievedAtMap = new Map(mine.map(m => [m.achievementId, m.achievedAt]))

    const data = achievements.map(a => ({
      ...a,
      isAchieved: achievedIds.has(a.id),
      achievedAt: achievedAtMap.get(a.id) || null,
      currentValue: metrics[a.metric] ?? 0,
      progressPercent: Math.min(100, Math.round(((metrics[a.metric] ?? 0) / parseFloat(a.threshold)) * 100))
    }))

    res.json({ success: true, data })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Engine: tính các chỉ số hiện tại của user theo từng AchievementMetric ──
const computeUserMetrics = async (userId) => {
  const [user, ownedCount, wheelCount, boxCount, auctionWins, marketplaceSales] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { totalDeposit: true, totalSpent: true } }),
    prisma.userOwnedAccount.count({ where: { userId } }),
    prisma.wheelHistory.count({ where: { userId } }),
    prisma.mysteryBoxOpenHistory.count({ where: { userId } }),
    prisma.auctionRoom.count({ where: { winnerId: userId, status: 'ENDED' } }),
    prisma.marketplaceListing.count({ where: { sellerId: userId, status: 'SOLD' } }),
  ])

  return {
    TOTAL_DEPOSIT: parseFloat(user?.totalDeposit || 0),
    TOTAL_SPENT: parseFloat(user?.totalSpent || 0),
    ACCOUNTS_OWNED: ownedCount,
    WHEEL_SPINS: wheelCount,
    MYSTERY_BOX_OPENED: boxCount,
    AUCTION_WINS: auctionWins,
    MARKETPLACE_SALES: marketplaceSales,
  }
}

// Gọi hàm này sau các hành động có thể ảnh hưởng chỉ số (nạp tiền, mua acc, quay, mở túi mù,
// thắng đấu giá, bán marketplace...) để tự động chấm & cấp thành tựu mới đạt được.
// Không throw lỗi ra ngoài — chạy "best effort", lỗi chỉ log để không làm hỏng luồng chính.
const checkAndGrantAchievements = async (userId) => {
  try {
    const [achievements, already] = await Promise.all([
      prisma.achievement.findMany({ where: { isActive: true } }),
      prisma.userAchievement.findMany({ where: { userId }, select: { achievementId: true } })
    ])

    const alreadyIds = new Set(already.map(a => a.achievementId))
    const pending = achievements.filter(a => !alreadyIds.has(a.id))
    if (pending.length === 0) return []

    const metrics = await computeUserMetrics(userId)
    const newlyGranted = []

    for (const a of pending) {
      const value = metrics[a.metric] ?? 0
      if (value >= parseFloat(a.threshold)) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.userAchievement.create({ data: { userId, achievementId: a.id } })

            if (a.rewardQuanHuy > 0) {
              const u = await tx.user.update({
                where: { id: userId },
                data: { quanHuyBalance: { increment: a.rewardQuanHuy } }
              })
              await tx.quanHuyTransaction.create({
                data: {
                  userId,
                  amount: a.rewardQuanHuy,
                  balanceBefore: u.quanHuyBalance - a.rewardQuanHuy,
                  balanceAfter: u.quanHuyBalance,
                  type: 'ACHIEVEMENT',
                  description: `Thành tựu: ${a.name}`,
                  referenceId: a.id
                }
              })
            }

            if (a.rewardBadgeId) {
              await tx.userBadge.upsert({
                where: { userId_badgeId: { userId, badgeId: a.rewardBadgeId } },
                update: {},
                create: { userId, badgeId: a.rewardBadgeId, note: `Thành tựu: ${a.name}` }
              })
            }

            await tx.notification.create({
              data: {
                userId,
                type: 'REWARD',
                title: 'Đạt thành tựu mới!',
                message: `Bạn vừa đạt thành tựu "${a.name}"${a.rewardQuanHuy > 0 ? ` (+${a.rewardQuanHuy} Quân Huy)` : ''}`
              }
            })
          })

          newlyGranted.push(a)
          emitToUser(userId, 'achievement:unlocked', { name: a.name, icon: a.icon, rewardQuanHuy: a.rewardQuanHuy })
          emitToUser(userId, 'balance:update', {})
        } catch (err) {
          // P2002 = đã có (race condition khi 2 request cùng lúc) → bỏ qua an toàn
          if (err.code !== 'P2002') console.error('[checkAndGrantAchievements]', err.message)
        }
      }
    }

    return newlyGranted
  } catch (e) {
    console.error('[checkAndGrantAchievements] error:', e.message)
    return []
  }
}

// ── Admin CRUD ──────────────────────────────────────────────────────────
const adminGetAchievements = async (req, res) => {
  try {
    const achievements = await prisma.achievement.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { rewardBadge: true, _count: { select: { users: true } } }
    })
    res.json({ success: true, data: achievements })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminCreateAchievement = async (req, res) => {
  try {
    const { name, description, icon, metric, threshold, rewardQuanHuy, rewardBadgeId, sortOrder } = req.body
    const achievement = await prisma.achievement.create({
      data: {
        name, description, icon,
        metric,
        threshold: parseFloat(threshold),
        rewardQuanHuy: parseInt(rewardQuanHuy || 0),
        rewardBadgeId: rewardBadgeId || null,
        sortOrder: parseInt(sortOrder || 0)
      }
    })
    res.status(201).json({ success: true, data: achievement })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminUpdateAchievement = async (req, res) => {
  try {
    const data = { ...req.body }
    if (data.threshold !== undefined) data.threshold = parseFloat(data.threshold)
    if (data.rewardQuanHuy !== undefined) data.rewardQuanHuy = parseInt(data.rewardQuanHuy)
    if (data.sortOrder !== undefined) data.sortOrder = parseInt(data.sortOrder)
    if (data.isActive !== undefined) data.isActive = data.isActive === 'true' || data.isActive === true
    if (data.rewardBadgeId !== undefined) data.rewardBadgeId = data.rewardBadgeId || null

    const achievement = await prisma.achievement.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: achievement })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminDeleteAchievement = async (req, res) => {
  try {
    await prisma.achievement.delete({ where: { id: req.params.id } })
    res.json({ success: true, message: 'Đã xóa thành tựu' })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

module.exports = {
  getAllAchievements, getMyAchievements, checkAndGrantAchievements,
  adminGetAchievements, adminCreateAchievement, adminUpdateAchievement, adminDeleteAchievement
}
