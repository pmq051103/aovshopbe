const express = require('express')
const router = express.Router()
const prisma = require('../config/prisma')
const { protect, adminOnly } = require('../middleware/authMiddleware')

const getWeek = date => {
  const onejan = new Date(date.getFullYear(), 0, 1)
  return Math.ceil((((date - onejan) / 86400000) + onejan.getDay() + 1) / 7)
}

const getPeriodKey = period => {
  const now = new Date()

  if (period === 'daily') {
    return `daily_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}`
  }

  if (period === 'weekly') {
    return `weekly_${now.getFullYear()}_${getWeek(now)}`
  }

  if (period === 'monthly') {
    return `monthly_${now.getFullYear()}_${now.getMonth() + 1}`
  }

  return null
}

const DEFAULT_REWARDS = [
  { rank: 1, label: 'Hạng 1', reward: '500,000đ', rewardAmount: 500000, type: 'BALANCE' },
  { rank: 2, label: 'Hạng 2', reward: '200,000đ', rewardAmount: 200000, type: 'BALANCE' },
  { rank: 3, label: 'Hạng 3', reward: '100,000đ', rewardAmount: 100000, type: 'BALANCE' },
]

const getRankingRewards = async () => {
  const setting = await prisma.siteConfig.findUnique({
    where: { key: 'ranking_rewards' },
  })

  if (!setting?.value) return DEFAULT_REWARDS

  try {
    const parsed = JSON.parse(setting.value)
    return Array.isArray(parsed) ? parsed : DEFAULT_REWARDS
  } catch {
    return DEFAULT_REWARDS
  }
}

// Public: lấy bảng xếp hạng
router.get('/', async (req, res) => {
  try {
    const { period = 'daily', limit = 50 } = req.query

    const periodKey = getPeriodKey(period)
    if (!periodKey) {
      return res.status(400).json({
        success: false,
        message: 'period không hợp lệ',
      })
    }

    const rewards = await getRankingRewards()

    const rankings = await prisma.ranking.findMany({
      where: { periodKey },
      take: parseInt(limit),
      orderBy: { totalDeposit: 'desc' },
      include: {
        user: {
          select: {
            username: true,
            displayName: true,
            avatar: true,
          },
        },
      },
    })

    const ranked = rankings.map((r, i) => {
      const rank = i + 1

      return {
        ...r,
        rank,
        reward: rewards.find(rw => Number(rw.rank) === rank) || null,
      }
    })

    res.json({
      success: true,
      data: ranked,
      rewards,
    })
  } catch (e) {
    console.error('ranking error:', e)
    res.status(500).json({
      success: false,
      message: 'Lỗi lấy bảng xếp hạng',
    })
  }
})

// Public: recent activity ticker
router.get('/recent-activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50)

    const recentTx = await prisma.transaction.findMany({
      where: {
        type: {
          in: ['PURCHASE', 'SPIN', 'MYSTERY_BOX', 'TOPUP_PURCHASE'],
        },
        status: 'COMPLETED',
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            username: true,
            displayName: true,
          },
        },
        gameAccount: {
          select: {
            title: true,
            code: true,
          },
        },
      },
    })

    const activities = recentTx.map(tx => {
      const raw = tx.user?.username || tx.user?.displayName || 'user'
      const masked =
        raw.length > 3
          ? raw.slice(0, 3) + '***'
          : raw.slice(0, 1) + '***'

      return {
        type: tx.type,
        username: masked,
        detail: tx.gameAccount?.title || null,
        createdAt: tx.createdAt,
      }
    })

    res.json({
      success: true,
      data: activities,
    })
  } catch (e) {
    console.error('recent-activity error:', e)
    res.status(500).json({
      success: false,
      message: 'Lỗi lấy hoạt động',
    })
  }
})

// Admin: lấy danh sách ranking
router.get('/admin/rankings', protect, adminOnly, async (req, res) => {
  try {
    const { period = 'daily', page = 1, limit = 20, search } = req.query

    let periodKey = null

    if (period === 'all') {
      periodKey = null
    } else if (['daily', 'weekly', 'monthly'].includes(period)) {
      periodKey = getPeriodKey(period)
    } else {
      periodKey = period
    }

    const where = {}

    if (periodKey) where.periodKey = periodKey

    if (search) {
      where.user = {
        OR: [
          { username: { contains: search } },
          { displayName: { contains: search } },
        ],
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const rewards = await getRankingRewards()

    const [items, total] = await Promise.all([
      prisma.ranking.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { totalDeposit: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              email: true,
            },
          },
        },
      }),
      prisma.ranking.count({ where }),
    ])

    const ranked = items.map((r, i) => {
      const rank = skip + i + 1

      return {
        ...r,
        rank,
        reward: rewards.find(rw => Number(rw.rank) === rank) || null,
      }
    })

    res.json({
      success: true,
      data: ranked,
      rewards,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (e) {
    console.error('admin ranking error:', e)
    res.status(500).json({
      success: false,
      message: 'Lỗi lấy ranking',
    })
  }
})

// Admin: lấy reward config
router.get('/admin/rewards', protect, adminOnly, async (req, res) => {
  try {
    const rewards = await getRankingRewards()

    res.json({
      success: true,
      data: rewards,
    })
  } catch (e) {
    console.error('get rewards error:', e)
    res.status(500).json({
      success: false,
      message: 'Lỗi lấy cấu hình phần thưởng',
    })
  }
})

// Admin: cập nhật reward config
router.put('/admin/rewards', protect, adminOnly, async (req, res) => {
  try {
    const { rewards } = req.body

    if (!Array.isArray(rewards)) {
      return res.status(400).json({
        success: false,
        message: 'rewards phải là mảng',
      })
    }

    const cleanRewards = rewards
      .map((r, index) => ({
        rank: Number(r.rank || index + 1),
        label: r.label || `Hạng ${r.rank || index + 1}`,
        reward: r.reward || '',
        rewardAmount: Number(r.rewardAmount || 0),
        type: r.type || 'BALANCE',
      }))
      .filter(r => r.rank > 0)

    await prisma.siteConfig.upsert({
      where: { key: 'ranking_rewards' },
      update: {
        value: JSON.stringify(cleanRewards),
        type: 'json',
        group: 'ranking',
      },
      create: {
        key: 'ranking_rewards',
        value: JSON.stringify(cleanRewards),
        type: 'json',
        group: 'ranking',
      },
    })

    res.json({
      success: true,
      message: 'Cập nhật phần thưởng thành công',
      data: cleanRewards,
    })
  } catch (e) {
    console.error('update rewards error:', e)
    res.status(500).json({
      success: false,
      message: 'Lỗi cập nhật phần thưởng',
    })
  }
})

// Admin: trao thưởng cho user
router.post('/admin/rankings/:id/reward', protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params
    const { rewardAmount, note } = req.body

    const ranking = await prisma.ranking.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            balance: true,
          },
        },
      },
    })

    if (!ranking) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy ranking',
      })
    }

    if (ranking.rewardClaimed) {
      return res.status(400).json({
        success: false,
        message: 'Đã trao thưởng rồi',
      })
    }

    const amount = parseFloat(rewardAmount)

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Số tiền không hợp lệ',
      })
    }

    await prisma.$transaction(async tx => {
      const user = await tx.user.findUnique({
        where: { id: ranking.userId },
      })

      const updated = await tx.user.update({
        where: { id: ranking.userId },
        data: {
          balance: {
            increment: amount,
          },
        },
      })

      await tx.transaction.create({
        data: {
          userId: ranking.userId,
          type: 'REWARD',
          status: 'COMPLETED',
          amount,
          balanceBefore: user.balance,
          balanceAfter: updated.balance,
          description: note || `Thưởng xếp hạng kỳ ${ranking.periodKey}`,
          referenceId: ranking.id,
        },
      })

      await tx.ranking.update({
        where: { id },
        data: {
          rewardClaimed: true,
        },
      })
    })

    res.json({
      success: true,
      message: 'Trao thưởng thành công',
    })
  } catch (e) {
    console.error('reward error:', e)
    res.status(500).json({
      success: false,
      message: 'Lỗi trao thưởng',
    })
  }
})

module.exports = router