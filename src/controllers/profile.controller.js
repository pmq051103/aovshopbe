const prisma = require('../config/prisma')

// Tổng hợp toàn bộ dữ liệu hiển thị trên trang Hồ sơ:
// avatar/VIP đã có sẵn trong user object (auth store), endpoint này bổ sung phần còn thiếu:
// badges, thành tựu, và các số liệu thống kê (tổng giao dịch, tổng nạp, tổng acc mua,
// tỷ lệ mở túi mù, lượt quay).
const getProfileOverview = async (req, res) => {
  try {
    const userId = req.user.id

    const [
      user,
      vipMembership,
      badges,
      achievementsRaw,
      totalTransactions,
      totalOwnedAccounts,
      wheelSpinCount,
      boxHistories,
      auctionWins,
      marketplaceSales,
      recentOwnedAccounts,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, username: true, email: true, displayName: true, avatar: true,
          role: true, balance: true, quanHuyBalance: true, totalDeposit: true,
          totalSpent: true, createdAt: true, emailVerified: true,
        }
      }),
      prisma.vipMembership.findUnique({ where: { userId }, include: { tier: true } }),
      prisma.userBadge.findMany({ where: { userId }, include: { badge: true }, orderBy: { awardedAt: 'desc' } }),
      prisma.userAchievement.findMany({ where: { userId }, include: { achievement: true }, orderBy: { achievedAt: 'desc' } }),
      prisma.transaction.count({ where: { userId } }),
      prisma.userOwnedAccount.count({ where: { userId } }),
      prisma.wheelHistory.count({ where: { userId } }),
      prisma.mysteryBoxOpenHistory.findMany({ where: { userId }, select: { rarity: true } }),
      prisma.auctionRoom.count({ where: { winnerId: userId, status: 'ENDED' } }),
      prisma.marketplaceListing.count({ where: { sellerId: userId, status: 'SOLD' } }),
      prisma.userOwnedAccount.findMany({ where: { userId }, orderBy: { receivedAt: 'desc' }, take: 6 }),
    ])

    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' })

    const totalBoxesOpened = boxHistories.length
    const rareBoxCount = boxHistories.filter(h => ['EPIC', 'LEGENDARY', 'MYTHIC'].includes(h.rarity)).length
    const boxRareRate = totalBoxesOpened > 0 ? Math.round((rareBoxCount / totalBoxesOpened) * 1000) / 10 : 0

    res.json({
      success: true,
      data: {
        user,
        vip: vipMembership ? {
          tier: vipMembership.tier,
          achievedAt: vipMembership.achievedAt,
        } : null,
        badges: badges.map(b => ({ id: b.badge.id, name: b.badge.name, icon: b.badge.icon, imageUrl: b.badge.imageUrl, color: b.badge.color, awardedAt: b.awardedAt })),
        achievements: achievementsRaw.map(a => ({ id: a.achievement.id, name: a.achievement.name, icon: a.achievement.icon, achievedAt: a.achievedAt })),
        stats: {
          totalTransactions,
          totalDeposit: parseFloat(user.totalDeposit),
          totalSpent: parseFloat(user.totalSpent),
          totalOwnedAccounts,
          wheelSpinCount,
          totalBoxesOpened,
          boxRareRate, // % túi mù mở ra vật phẩm hiếm (EPIC trở lên)
          auctionWins,
          marketplaceSales,
        },
        recentOwnedAccounts,
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

module.exports = { getProfileOverview }
