const { emitToAll, emitToUser } = require('../config/socket')
const prisma = require('../config/prisma')
const { getUserVipDiscounts, recalculateVip } = require('./vip.controller')

const selectReward = (rewards) => {
  const random = Math.random(); let c = 0
  for (const r of rewards) { c += parseFloat(r.probability); if (random <= c) return r }
  return rewards[rewards.length - 1]
}

const getWheel = async (req, res) => {
  try {
    const wheel = await prisma.luckyWheel.findFirst({ where: { isActive: true }, include: { rewards: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } } })
    if (!wheel) return res.status(404).json({ success: false, message: 'Vòng quay không có sẵn' })

    // Tính spinCost sau VIP nếu user đã login
    let vipSpinCost = parseFloat(wheel.spinCost)
    let vipDiscountPercent = 0
    let vipTierName = null
    if (req.user?.id) {
      const { wheelPercent, tier } = await getUserVipDiscounts(req.user.id)
      if (wheelPercent > 0) {
        vipDiscountPercent = wheelPercent
        vipTierName = tier?.name || null
        vipSpinCost = Math.max(0, Math.round(parseFloat(wheel.spinCost) * (1 - wheelPercent / 100)))
      }
    }

    res.json({
      success: true,
      data: {
        ...wheel,
        vipSpinCost,
        vipDiscountPercent,
        vipTierName,
      }
    })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const spin = async (req, res) => {
  try {
    const wheel = await prisma.luckyWheel.findFirst({
      where: { isActive: true },
      include: {
        rewards: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' }
        }
      }
    });

    if (!wheel) {
      return res.status(404).json({
        success: false,
        message: 'Vòng quay không khả dụng'
      });
    }

    if (!wheel.rewards || wheel.rewards.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Vòng quay chưa có phần thưởng'
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy người dùng'
      });
    }

    // Áp dụng giảm giá VIP (nếu có) cho chi phí quay — cùng công thức với getWheel
    // để giá hiển thị và giá thực trừ luôn khớp nhau.
    let actualSpinCost = parseFloat(wheel.spinCost);
    const { wheelPercent } = await getUserVipDiscounts(req.user.id);
    if (wheelPercent > 0) {
      actualSpinCost = Math.max(0, Math.round(parseFloat(wheel.spinCost) * (1 - wheelPercent / 100)));
    }

    if (parseFloat(user.balance) < actualSpinCost) {
      return res.status(400).json({
        success: false,
        message: 'Số dư không đủ',
        required: actualSpinCost
      });
    }

    const selectedReward = selectReward(wheel.rewards);

    if (!selectedReward) {
      return res.status(500).json({
        success: false,
        message: 'Lỗi chọn phần thưởng'
      });
    }

    const rewardIndex = wheel.rewards.findIndex(
      r => r.id === selectedReward.id
    );

    const result = await prisma.$transaction(async (tx) => {
      // Guard số dư nguyên tử (H2): chỉ trừ khi balance >= actualSpinCost, chống quay
      // song song đẩy số dư âm & nhận thưởng nhiều hơn tiền thật.
      const pay = await tx.user.updateMany({
        where: { id: req.user.id, balance: { gte: actualSpinCost } },
        data: {
          balance: { decrement: actualSpinCost },
          totalSpent: { increment: actualSpinCost }
        }
      });
      if (pay.count === 0) {
        const err = new Error('INSUFFICIENT_BALANCE'); err.code = 'INSUFFICIENT_BALANCE'; throw err
      }
      let updatedUser = await tx.user.findUnique({ where: { id: req.user.id } });

      let rewardValue = selectedReward.value;

      if (selectedReward.type === 'BALANCE' || selectedReward.type === 'SPIN') {
        updatedUser = await tx.user.update({
          where: { id: req.user.id },
          data: {
            balance: { increment: selectedReward.value }
          }
        });
      }

      if (selectedReward.type === 'QUAN_HUY') {
        const quanHuyAmount = parseInt(selectedReward.value) || 0;

        updatedUser = await tx.user.update({
          where: { id: req.user.id },
          data: {
            quanHuyBalance: { increment: quanHuyAmount }
          }
        });

        await tx.quanHuyTransaction.create({
          data: {
            userId: req.user.id,
            amount: quanHuyAmount,
            balanceBefore: user.quanHuyBalance,
            balanceAfter: parseInt(user.quanHuyBalance || 0) + quanHuyAmount,
            type: 'LUCKY_WHEEL',
            description: `Vòng quay → ${selectedReward.name}`,
            referenceId: selectedReward.id
          }
        });

        rewardValue = 0;
      }

      let wheelOwnedAccount = null;

      if (selectedReward.type === 'ACCOUNT' && selectedReward.rewardAccountId) {
        const rewardAcc = await tx.gameAccount.findUnique({
          where: { id: selectedReward.rewardAccountId },
          include: {
            images: {
              orderBy: { sortOrder: 'asc' }
            }
          }
        });

        if (rewardAcc && rewardAcc.status === 'AVAILABLE') {
          await tx.gameAccount.update({
            where: { id: rewardAcc.id },
            data: {
              status: 'SOLD',
              soldAt: new Date(),
              soldToId: req.user.id
            }
          });

          wheelOwnedAccount = await tx.userOwnedAccount.create({
            data: {
              userId: req.user.id,
              accountId: rewardAcc.id,
              sourceType: 'LUCKY_WHEEL',
              sourceId: selectedReward.id,
              snapshotData: JSON.stringify({
                title: rewardAcc.title,
                code: rewardAcc.code,
                rank: rewardAcc.rank,
                server: rewardAcc.server,
                champions: rewardAcc.champions,
                skins: rewardAcc.skins,
                level: rewardAcc.level,
                winRate: rewardAcc.winRate,
                matches: rewardAcc.matches,
                gems: rewardAcc.gems,
                price: rewardAcc.price,
                thumbnailUrl: rewardAcc.thumbnailUrl,
                images: rewardAcc.images?.map(i => ({
                  url: i.url,
                  sortOrder: i.sortOrder
                })) || [],
                gameUsername: rewardAcc.gameUsername,
                gamePassword: rewardAcc.gamePassword,
                gameBindEmail: rewardAcc.gameBindEmail,
                gameBindPhone: rewardAcc.gameBindPhone,
                gameBindFacebook: rewardAcc.gameBindFacebook,
                tags: rewardAcc.tags,
                isVerified: rewardAcc.isVerified,
                rewardName: selectedReward.name,
                rarity: selectedReward.rarity
              })
            }
          });
        }

        rewardValue = 0;
      }

      await tx.luckyWheelReward.update({
        where: { id: selectedReward.id },
        data: {
          wonCount: { increment: 1 }
        }
      });

      const history = await tx.wheelHistory.create({
        data: {
          userId: req.user.id,
          wheelId: wheel.id,
          rewardId: selectedReward.id,
          spinCost: actualSpinCost,
          rewardValue,
          rewardName: selectedReward.name,
          rarity: selectedReward.rarity
        }
      });

      await tx.transaction.create({
        data: {
          userId: req.user.id,
          type: 'SPIN',
          amount: parseFloat(rewardValue) - actualSpinCost,
          balanceBefore: user.balance,
          balanceAfter: updatedUser.balance,
          description: `Vòng quay → ${selectedReward.name}`,
          referenceId: history.id
        }
      });

      return {
        history,
        updatedUser,
        wheelOwnedAccount
      };
    }, {
      timeout: 15000
    });

    prisma.notification.create({
      data: {
        userId: req.user.id,
        type: 'SPIN',
        title: '🎰 Kết quả quay!',
        message: `Nhận: ${selectedReward.name} (${selectedReward.rarity})`,
        data: {
          rewardId: selectedReward.id,
          rewardName: selectedReward.name,
          rewardType: selectedReward.type,
          rarity: selectedReward.rarity
        }
      }
    }).catch(err => console.error('spin notification:', err));

    recalculateVip(req.user.id).catch(err =>
      console.error('recalculateVip after spin:', err)
    );

    emitToUser(req.user.id, 'balance:update', {
      balance: result.updatedUser.balance,
      quanHuyBalance: result.updatedUser.quanHuyBalance
    });

    emitToAll('wheel:winner', {
      userId: req.user.id,
      username: req.user.displayName || req.user.username,
      avatar: req.user.avatar,
      reward: selectedReward.name,
      rarity: selectedReward.rarity
    });

    return res.json({
      success: true,
      message: 'Quay thành công',
      data: {
        reward: selectedReward,
        rewardIndex,
        history: result.history,
        newBalance: result.updatedUser.balance,
        newQuanHuyBalance: result.updatedUser.quanHuyBalance,
        ownedAccountId: result.wheelOwnedAccount?.id || null
      }
    });
  } catch (e) {
    console.error('spin error:', e);
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ success: false, message: 'Số dư không đủ' });
    }
    // Không trả e.message thô ra client (M5)
    return res.status(500).json({ success: false, message: 'Lỗi quay' });
  }
};

const getHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query
    const [histories, total] = await Promise.all([
      prisma.wheelHistory.findMany({ where: { userId: req.user.id }, skip: (parseInt(page) - 1) * parseInt(limit), take: parseInt(limit), orderBy: { createdAt: 'desc' }, include: { reward: true } }),
      prisma.wheelHistory.count({ where: { userId: req.user.id } })
    ])
    res.json({ success: true, data: histories, pagination: { page: parseInt(page), total } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const getRecentWinners = async (req, res) => {
  try {
    const winners = await prisma.wheelHistory.findMany({ where: { rarity: { in: ['EPIC', 'LEGENDARY', 'MYTHIC'] } }, take: 10, orderBy: { createdAt: 'desc' }, include: { user: { select: { username: true, displayName: true, avatar: true } } } })
    res.json({ success: true, data: winners })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── ADMIN ─────────────────────────────────────────
const adminGetWheels = async (req, res) => {
  try {
    const wheels = await prisma.luckyWheel.findMany({ include: { rewards: { orderBy: { sortOrder: 'asc' } }, _count: { select: { histories: true } } }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: wheels })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}
const adminCreateWheel = async (req, res) => {
  try {
    const { name, description, spinCost, isActive } = req.body
    const wheel = await prisma.luckyWheel.create({ data: { name, description, spinCost: parseFloat(spinCost), isActive: isActive === 'true' || isActive === true, imageUrl: req.file?.path } })
    res.status(201).json({ success: true, data: wheel })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}
const adminUpdateWheel = async (req, res) => {
  try {
    const { id } = req.params
    const data = {}

    if (req.body.name !== undefined) data.name = req.body.name
    if (req.body.description !== undefined) data.description = req.body.description

    if (req.body.spinCost !== undefined) {
      const spinCost = Number(req.body.spinCost)

      if (Number.isNaN(spinCost) || spinCost <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Chi phí quay không hợp lệ'
        })
      }

      data.spinCost = spinCost
    }

    if (req.body.isActive !== undefined) {
      data.isActive = req.body.isActive === 'true' || req.body.isActive === true
    }

    if (req.file?.path) {
      data.imageUrl = req.file.path
    }

    const wheel = await prisma.luckyWheel.update({
      where: { id },
      data,
      include: {
        rewards: {
          orderBy: { sortOrder: 'asc' }
        },
        _count: {
          select: { histories: true }
        }
      }
    })

    res.json({
      success: true,
      message: 'Cập nhật vòng quay thành công',
      data: wheel
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}
const adminDeleteWheel = async (req, res) => {
  try { await prisma.luckyWheel.delete({ where: { id: req.params.id } }); res.json({ success: true, message: 'Đã xóa' }) }
  catch (e) { res.status(500).json({ success: false, message: e.message }) }
}
const adminCreateReward = async (req, res) => {
  try {
    const wheelId = req.params.wheelId
    const { name, description, type, value, probability, rarity, color, sortOrder,
      rewardAccountId, rewardSpinCount, couponCode, quanHuyAmount } = req.body

    const existing = await prisma.luckyWheelReward.aggregate({
      where: { wheelId, isActive: true }, _sum: { probability: true }
    })
    const currentSum = parseFloat(existing._sum.probability || 0)
    if (currentSum + parseFloat(probability) > 1.0001)
      return res.status(400).json({ success: false, message: `Tổng xác suất vượt 100% (hiện: ${(currentSum * 100).toFixed(1)}%)` })

    const reward = await prisma.luckyWheelReward.create({
      data: {
        wheelId, name, description,
        type: type || 'BALANCE',
        value: parseFloat(value),
        probability: parseFloat(probability),
        rarity, color,
        sortOrder: parseInt(sortOrder || 0),
        imageUrl: req.file?.path,
        rewardAccountId: rewardAccountId || null,
        rewardSpinCount: rewardSpinCount ? parseInt(rewardSpinCount) : null,
        couponCode: couponCode || null,
        quanHuyAmount: quanHuyAmount ? parseInt(quanHuyAmount) : null,
      }
    })
    res.status(201).json({ success: true, data: reward })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminUpdateReward = async (req, res) => {
  try {
    const data = { ...req.body }
    if (data.value) data.value = parseFloat(data.value)
    if (data.probability) data.probability = parseFloat(data.probability)
    if (data.sortOrder) data.sortOrder = parseInt(data.sortOrder)
    if (data.isActive !== undefined) data.isActive = data.isActive === 'true' || data.isActive === true
    if (data.rewardSpinCount !== undefined) data.rewardSpinCount = data.rewardSpinCount ? parseInt(data.rewardSpinCount) : null
    if (data.quanHuyAmount !== undefined) data.quanHuyAmount = data.quanHuyAmount ? parseInt(data.quanHuyAmount) : null
    if (data.rewardAccountId !== undefined) data.rewardAccountId = data.rewardAccountId || null
    if (data.couponCode !== undefined) data.couponCode = data.couponCode || null

    // ← THÊM DÒNG NÀY
    if (req.file?.path) data.imageUrl = req.file.path

    const reward = await prisma.luckyWheelReward.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: reward })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}
const adminDeleteReward = async (req, res) => {
  try { await prisma.luckyWheelReward.delete({ where: { id: req.params.id } }); res.json({ success: true, message: 'Đã xóa' }) }
  catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminGetWheelStats = async (req, res) => {
  try {
    const { id } = req.params
    const [wheel, rewardStats, revenue, recentWinners] = await Promise.all([
      prisma.luckyWheel.findUnique({ where: { id }, include: { rewards: true, _count: { select: { histories: true } } } }),
      prisma.wheelHistory.groupBy({ by: ['rarity'], where: { wheelId: id }, _count: true }),
      prisma.wheelHistory.aggregate({ where: { wheelId: id }, _sum: { spinCost: true, rewardValue: true } }),
      prisma.wheelHistory.findMany({ where: { wheelId: id, rarity: { in: ['EPIC', 'LEGENDARY', 'MYTHIC'] } }, take: 10, orderBy: { createdAt: 'desc' }, include: { user: { select: { username: true, displayName: true, avatar: true } } } })
    ])
    res.json({ success: true, data: { wheel, rewardStats, totalSpins: wheel._count.histories, totalRevenue: parseFloat(revenue._sum.spinCost || 0), totalPayout: parseFloat(revenue._sum.rewardValue || 0), profit: parseFloat(revenue._sum.spinCost || 0) - parseFloat(revenue._sum.rewardValue || 0), recentWinners } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminGetWheelHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, rarity, search, type } = req.query

    const where = {}

    if (rarity && rarity !== 'ALL') {
      where.rarity = rarity
    }
    if (type && type !== 'ALL') {
      where.reward = {
        type
      }
    }

    if (search) {
      where.user = {
        OR: [
          { username: { contains: search } },
          { displayName: { contains: search } },
          { email: { contains: search } },
        ],
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const take = parseInt(limit)

    const [histories, total] = await Promise.all([
      prisma.wheelHistory.findMany({
        where,
        skip,
        take,
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
          reward: true,
        },
      }),
      prisma.wheelHistory.count({ where }),
    ])

    res.json({
      success: true,
      data: histories,
      pagination: {
        page: parseInt(page),
        limit: take,
        total,
        pages: Math.ceil(total / take),
      },
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

module.exports = { getWheel, spin, getHistory, getRecentWinners, adminGetWheels, adminCreateWheel, adminUpdateWheel, adminDeleteWheel, adminCreateReward, adminUpdateReward, adminDeleteReward, adminGetWheelStats, adminGetWheelHistory }