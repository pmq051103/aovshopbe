const prisma = require('../config/prisma')

const getDashboardStats = async (req, res) => {
  try {
    const { range = '7d', from, to } = req.query

    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    let chartDays = 7
    let rangeStart = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
    let rangeEnd = now
    let rangeLabel = '7 ngày'

    if (range === '30d') {
      chartDays = 30
      rangeStart = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)
      rangeEnd = now
      rangeLabel = '30 ngày'
    }

    if (range === 'month') {
      chartDays = now.getDate()
      rangeStart = startOfMonth
      rangeEnd = now
      rangeLabel = 'tháng này'
    }

    if (range === 'all') {
      chartDays = 30
      rangeStart = new Date(0)
      rangeEnd = now
      rangeLabel = 'tất cả'
    }

    if (range === 'custom' && from && to) {
      rangeStart = new Date(from)
      rangeStart.setHours(0, 0, 0, 0)
      rangeEnd = new Date(to)
      rangeEnd.setHours(23, 59, 59, 999)
      const diffTime = rangeEnd.getTime() - rangeStart.getTime()
      chartDays = Math.max(1, Math.ceil(diffTime / 86400000) + 1)
      if (chartDays > 90) chartDays = 90
      rangeLabel = `${from} đến ${to}`
    }

    const rangeWhere = { createdAt: { gte: rangeStart, lte: rangeEnd } }

    // Các loại giao dịch sinh doanh thu (số âm = user chi tiền)
    const revenueTypes = ['PURCHASE', 'SPIN', 'MYSTERY_BOX', 'TOPUP_PURCHASE']

    const [
      totalUsers,
      newUsersToday,
      totalAccounts,
      soldAccounts,
      availableAccounts,

      // ── Doanh thu tổng hợp ──────────────────────────────────────────
      totalRevenue,
      revenueToday,
      revenueRange,

      // ── Doanh thu hôm nay theo từng loại ────────────────────────────
      revShopToday,
      revMysteryToday,
      revWheelToday,
      revTopupToday,
      revCardToday,

      // ── Doanh thu trong range theo từng loại ────────────────────────
      revShopRange,
      revMysteryRange,
      revWheelRange,
      revTopupRange,
      revCardRange,

      // ── Nạp tiền (chuyển khoản) ──────────────────────────────────────
      totalDeposits,
      depositToday,
      depositRange,
      depositTodayAmount,

      // ── Thống kê module phụ ──────────────────────────────────────────
      totalMysteryBoxAccounts,
      soldMysteryBoxAccounts,
      totalWheelSpins,
      wheelSpinsToday,
      totalTopupOrders,
      topupOrdersToday,
      totalCardDeposits,
      cardDepositsToday,

      // ── Danh sách gần đây ─────────────────────────────────────────────
      recentTransactions,
      recentDeposits,
      topUsers
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.user.count({ where: { role: 'USER', createdAt: { gte: startOfDay } } }),

      prisma.gameAccount.count(),
      prisma.gameAccount.count({ where: { status: 'SOLD' } }),
      prisma.gameAccount.count({ where: { status: 'AVAILABLE' } }),

      // Tổng doanh thu tất cả thời gian
      prisma.transaction.aggregate({
        where: { type: { in: revenueTypes }, status: 'COMPLETED', amount: { lt: 0 } },
        _sum: { amount: true }
      }),

      // Doanh thu hôm nay (tổng hợp)
      prisma.transaction.aggregate({
        where: { type: { in: revenueTypes }, status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: startOfDay } },
        _sum: { amount: true }
      }),

      // Doanh thu trong range (tổng hợp)
      prisma.transaction.aggregate({
        where: { type: { in: revenueTypes }, status: 'COMPLETED', amount: { lt: 0 }, ...rangeWhere },
        _sum: { amount: true }
      }),

      // Shop acc — hôm nay
      prisma.transaction.aggregate({
        where: { type: 'PURCHASE', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: startOfDay } },
        _sum: { amount: true }
      }),

      // Túi mù — hôm nay (amount âm, không cần filter lt:0 vì luôn âm)
      prisma.transaction.aggregate({
        where: { type: 'MYSTERY_BOX', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: startOfDay } },
        _sum: { amount: true }
      }),

      // Vòng quay — hôm nay
      prisma.transaction.aggregate({
        where: { type: 'SPIN', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: startOfDay } },
        _sum: { amount: true }
      }),

      // Nạp quân huy — hôm nay
      prisma.transaction.aggregate({
        where: { type: 'TOPUP_PURCHASE', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: startOfDay } },
        _sum: { amount: true }
      }),

      // Nạp thẻ — hôm nay
      prisma.cardDeposit.aggregate({
        where: { status: 'SUCCESS', createdAt: { gte: startOfDay } },
        _sum: { receivedAmount: true }
      }).catch(() => ({ _sum: { receivedAmount: 0 } })),

      // Shop acc — range
      prisma.transaction.aggregate({
        where: { type: 'PURCHASE', status: 'COMPLETED', amount: { lt: 0 }, ...rangeWhere },
        _sum: { amount: true }
      }),

      // Túi mù — range
      prisma.transaction.aggregate({
        where: { type: 'MYSTERY_BOX', status: 'COMPLETED', amount: { lt: 0 }, ...rangeWhere },
        _sum: { amount: true }
      }),

      // Vòng quay — range
      prisma.transaction.aggregate({
        where: { type: 'SPIN', status: 'COMPLETED', amount: { lt: 0 }, ...rangeWhere },
        _sum: { amount: true }
      }),

      // Nạp quân huy — range
      prisma.transaction.aggregate({
        where: { type: 'TOPUP_PURCHASE', status: 'COMPLETED', amount: { lt: 0 }, ...rangeWhere },
        _sum: { amount: true }
      }),

      // Nạp thẻ — range
      prisma.cardDeposit.aggregate({
        where: { status: 'SUCCESS', ...rangeWhere },
        _sum: { receivedAmount: true }
      }).catch(() => ({ _sum: { receivedAmount: 0 } })),

      // Nạp tiền chuyển khoản — counts
      prisma.deposit.count({ where: { status: 'COMPLETED' } }),
      prisma.deposit.count({ where: { status: 'COMPLETED', createdAt: { gte: startOfDay } } }),
      prisma.deposit.aggregate({ where: { status: 'COMPLETED', ...rangeWhere }, _sum: { amount: true } }),
      prisma.deposit.aggregate({ where: { status: 'COMPLETED', createdAt: { gte: startOfDay } }, _sum: { amount: true } }),

      // Thống kê module
      prisma.mysteryBoxAccount.count(),
      prisma.mysteryBoxAccount.count({ where: { isSold: true } }),
      prisma.wheelHistory.count().catch(() => 0),
      prisma.wheelHistory.count({ where: { createdAt: { gte: startOfDay } } }).catch(() => 0),
      prisma.gameTopupOrder.count({ where: { status: 'COMPLETED' } }).catch(() => 0),
      prisma.gameTopupOrder.count({ where: { status: 'COMPLETED', createdAt: { gte: startOfDay } } }).catch(() => 0),
      prisma.cardDeposit.count({ where: { status: 'SUCCESS' } }).catch(() => 0),
      prisma.cardDeposit.count({ where: { status: 'SUCCESS', createdAt: { gte: startOfDay } } }).catch(() => 0),

      // Danh sách gần đây
      prisma.transaction.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { username: true, avatar: true } } }
      }),

      prisma.deposit.findMany({
        take: 10,
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { username: true } } }
      }),

      prisma.user.findMany({
        take: 5,
        orderBy: { totalDeposit: 'desc' },
        select: { id: true, username: true, displayName: true, avatar: true, totalDeposit: true, totalSpent: true }
      })
    ])

    // ── Build revenue chart theo ngày ─────────────────────────────────────
    const revenueChart = []

    for (let i = chartDays - 1; i >= 0; i--) {
      const date = new Date(rangeEnd)
      date.setDate(date.getDate() - i)

      const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const dayEnd = new Date(dayStart.getTime() + 86400000)

      const [revShop, revMystery, revWheel, revTopup, revCard, dep] = await Promise.all([
        prisma.transaction.aggregate({
          where: { type: 'PURCHASE', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { amount: true }
        }),
        prisma.transaction.aggregate({
          where: { type: 'MYSTERY_BOX', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { amount: true }
        }),
        prisma.transaction.aggregate({
          where: { type: 'SPIN', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { amount: true }
        }),
        prisma.transaction.aggregate({
          where: { type: 'TOPUP_PURCHASE', status: 'COMPLETED', amount: { lt: 0 }, createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { amount: true }
        }),
        prisma.cardDeposit.aggregate({
          where: { status: 'SUCCESS', createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { receivedAmount: true }
        }).catch(() => ({ _sum: { receivedAmount: 0 } })),
        prisma.deposit.aggregate({
          where: { status: 'COMPLETED', createdAt: { gte: dayStart, lt: dayEnd } },
          _sum: { amount: true }
        })
      ])

      const shopRevDay    = Math.abs(parseFloat(revShop._sum.amount    || 0))
      const mysteryRevDay = Math.abs(parseFloat(revMystery._sum.amount || 0))
      const wheelRevDay   = Math.abs(parseFloat(revWheel._sum.amount   || 0))
      const topupRevDay   = Math.abs(parseFloat(revTopup._sum.amount   || 0))
      const cardRevDay    = parseFloat(revCard._sum.receivedAmount      || 0)

      revenueChart.push({
        date: dayStart.toLocaleDateString('vi-VN', { month: 'short', day: 'numeric' }),
        revenue:        shopRevDay + mysteryRevDay + wheelRevDay + topupRevDay,
        shopRevenue:    shopRevDay,
        mysteryRevenue: mysteryRevDay,
        wheelRevenue:   wheelRevDay,
        topupRevenue:   topupRevDay,
        cardRevenue:    cardRevDay,
        deposit:        parseFloat(dep._sum.amount || 0)
      })
    }

    // ── Helper ─────────────────────────────────────────────────────────────
    const abs = (v) => Math.abs(parseFloat(v || 0))

    res.json({
      success: true,
      data: {
        range,
        rangeLabel,
        from: rangeStart,
        to: rangeEnd,

        users: {
          total:    totalUsers,
          newToday: newUsersToday
        },

        accounts: {
          total:     totalAccounts,
          sold:      soldAccounts,
          available: availableAccounts
        },

        revenue: {
          total: abs(totalRevenue._sum.amount),
          today: abs(revenueToday._sum.amount),
          range: abs(revenueRange._sum.amount)
        },

        // Chi tiết doanh thu từng loại hình kinh doanh
        revenueBreakdown: {
          today: {
            shop:      abs(revShopToday._sum.amount),
            mysteryBox:abs(revMysteryToday._sum.amount),
            wheel:     abs(revWheelToday._sum.amount),
            topup:     abs(revTopupToday._sum.amount),
            card:      parseFloat(revCardToday._sum.receivedAmount || 0),
            total:     abs(revShopToday._sum.amount) + abs(revMysteryToday._sum.amount) +
                       abs(revWheelToday._sum.amount) + abs(revTopupToday._sum.amount)
          },
          range: {
            shop:      abs(revShopRange._sum.amount),
            mysteryBox:abs(revMysteryRange._sum.amount),
            wheel:     abs(revWheelRange._sum.amount),
            topup:     abs(revTopupRange._sum.amount),
            card:      parseFloat(revCardRange._sum.receivedAmount || 0),
            total:     abs(revShopRange._sum.amount) + abs(revMysteryRange._sum.amount) +
                       abs(revWheelRange._sum.amount) + abs(revTopupRange._sum.amount)
          }
        },

        deposits: {
          total:       totalDeposits,
          today:       depositToday,
          todayAmount: parseFloat(depositTodayAmount._sum.amount || 0),
          rangeAmount: parseFloat(depositRange._sum.amount || 0)
        },

        // Thống kê nhanh từng module
        quickStats: {
          accounts: {
            total:     totalAccounts,
            sold:      soldAccounts,
            available: availableAccounts
          },
          mysteryBox: {
            total:     totalMysteryBoxAccounts,
            sold:      soldMysteryBoxAccounts,
            available: totalMysteryBoxAccounts - soldMysteryBoxAccounts
          },
          wheel: {
            totalSpins: totalWheelSpins,
            spinsToday: wheelSpinsToday
          },
          topup: {
            totalOrders: totalTopupOrders,
            ordersToday: topupOrdersToday
          },
          card: {
            totalDeposits: totalCardDeposits,
            depositsToday: cardDepositsToday
          }
        },

        revenueChart,
        recentTransactions,
        pendingDeposits: recentDeposits,
        topUsers
      }
    })
  } catch (error) {
    console.error('DASHBOARD ERROR:', error)
    res.status(500).json({ success: false, message: 'Lỗi lấy thống kê', error: error.message })
  }
}

const getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, role, banned } = req.query;
    const where = {};
    if (search) where.OR = [{ username: { contains: search } }, { email: { contains: search } }, { displayName: { contains: search } }];
    if (role) where.role = role.toUpperCase();
    if (banned !== undefined) where.isBanned = banned === 'true';

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where, skip: (parseInt(page) - 1) * parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        select: { id: true, username: true, email: true, displayName: true, avatar: true, role: true, balance: true, totalDeposit: true, totalSpent: true, isActive: true, isBanned: true, banReason: true, createdAt: true, lastLogin: true, loginCount: true }
      }),
      prisma.user.count({ where })
    ]);

    res.json({ success: true, data: users, pagination: { page: parseInt(page), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách người dùng' });
  }
};

const banUser = async (req, res) => {
  try {
    const { banReason } = req.body;
    await prisma.user.update({
      where: { id: req.params.id },
      data: { isBanned: true, banReason: banReason || 'Vi phạm điều khoản' }
    });
    res.json({ success: true, message: 'Khóa tài khoản thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi khóa tài khoản' });
  }
};

const unbanUser = async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { isBanned: false, banReason: null } });
    res.json({ success: true, message: 'Mở khóa tài khoản thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi mở khóa' });
  }
};

const adjustBalance = async (req, res) => {
  try {
    const { amount, description } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ success: false, message: 'Không tìm thấy người dùng' });

    const newBalance = parseFloat(user.balance) + parseFloat(amount);
    if (newBalance < 0) return res.status(400).json({ success: false, message: 'Số dư không được âm' });

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { balance: newBalance } }),
      prisma.transaction.create({
        data: {
          userId: user.id, type: amount > 0 ? 'REWARD' : 'REFUND',
          amount: parseFloat(amount), balanceBefore: user.balance, balanceAfter: newBalance,
          description: description || `Admin điều chỉnh số dư: ${amount > 0 ? '+' : ''}${amount}`
        }
      })
    ]);

    res.json({ success: true, message: 'Điều chỉnh số dư thành công', data: { newBalance } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi điều chỉnh số dư' });
  }
};

const getAllDeposits = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const where = {};
    if (status) where.status = status.toUpperCase();

    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where, skip: (parseInt(page) - 1) * parseInt(limit), take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { username: true, email: true, avatar: true } } }
      }),
      prisma.deposit.count({ where })
    ]);

    res.json({ success: true, data: deposits, pagination: { page: parseInt(page), total } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi lấy danh sách nạp tiền' });
  }
};

const getBadgeCounts = async (req, res) => {
  try {
    const [pendingOrders, pendingDeposits, unreadTickets, pendingTopup, pendingCards] = await Promise.all([
      prisma.order.count({ where: { status: 'PENDING' } }),
      prisma.deposit.count({ where: { status: 'PENDING' } }),
      prisma.ticket.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          messages: { some: { senderRole: 'USER', isRead: false } }
        }
      }),
      prisma.gameTopupOrder.count({ where: { status: 'PENDING' } }),
      prisma.cardDeposit.count({ where: { status: 'PENDING' } }),
    ])

    res.json({
      success: true,
      data: {
        '/admin/orders':      pendingOrders,
        '/admin/deposits':    pendingDeposits,
        '/admin/tickets':     unreadTickets,
        '/admin/topup':       pendingTopup,
        '/admin/card-config': pendingCards,
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

module.exports = { getDashboardStats, getUsers, banUser, unbanUser, adjustBalance, getAllDeposits, getBadgeCounts };