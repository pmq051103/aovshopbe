const prisma = require("../config/prisma");
const { emitToUser } = require("../config/socket");

// Lấy tất cả VIP tiers (public)
const getVipTiers = async (req, res) => {
  try {
    const tiers = await prisma.vipTier.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    res.json({ success: true, data: tiers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Lấy VIP hiện tại của user
// Nếu membership chưa đồng bộ (ví dụ admin vừa đổi tier), tự recalculate trước khi trả về.
const getMyVip = async (req, res) => {
  try {
    // Đảm bảo membership luôn đúng với totalSpent hiện tại
    await recalculateVip(req.user.id);

    const membership = await prisma.vipMembership.findUnique({
      where: { userId: req.user.id },
      include: { tier: true },
    });

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { totalSpent: true },
    });

    const tiers = await prisma.vipTier.findMany({
      where: { isActive: true },
      orderBy: { minSpent: "asc" },
    });
    const currentTotalSpent = parseFloat(user.totalSpent);

    // currentMinSpent = minSpent của tier hiện tại (hoặc 0 nếu chưa có hạng)
    const currentMinSpent = membership
      ? parseFloat(membership.tier.minSpent)
      : 0;
    // nextTier = tier kế tiếp mà user chưa đạt
    const nextTier = tiers.find(
      (t) => parseFloat(t.minSpent) > currentTotalSpent,
    );

    let progressToNext = 100;
    if (nextTier) {
      const range = parseFloat(nextTier.minSpent) - currentMinSpent;
      progressToNext =
        range > 0 ? ((currentTotalSpent - currentMinSpent) / range) * 100 : 100;
    }

    res.json({
      success: true,
      data: {
        membership,
        totalSpent: currentTotalSpent,
        nextTier,
        progressToNext,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Helper: tính và cập nhật VIP cho 1 user dựa trên totalSpent hiện tại.
// Gọi từ: mua hàng (account/card/box), và getMyVip (để luôn đồng bộ khi admin đổi tier).
const recalculateVip = async (userId, { skipBonuses = false } = {}) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { totalSpent: true, balance: true, quanHuyBalance: true },
    });
    const totalSpent = parseFloat(user.totalSpent);

    const tiers = await prisma.vipTier.findMany({
      where: { isActive: true },
      orderBy: { minSpent: "desc" },
    });

    const earnedTier = tiers.find((t) => totalSpent >= parseFloat(t.minSpent));
    const existing = await prisma.vipMembership.findUnique({
      where: { userId },
    });

    if (!earnedTier) {
      // User không đủ điều kiện cho bất kỳ tier nào → xóa membership nếu có
      if (existing) {
        await prisma.vipMembership.delete({ where: { userId } });
      }
      return;
    }

    if (existing?.tierId === earnedTier.id) return; // Đã đúng tier rồi

    // Kiểm tra có phải lên hạng (upgrade) hay không
    const isUpgrade =
      !existing ||
      (() => {
        const oldTier = tiers.find((t) => t.id === existing.tierId);
        return (
          !oldTier ||
          parseFloat(earnedTier.minSpent) > parseFloat(oldTier.minSpent)
        );
      })();

    // Cập nhật membership
    await prisma.vipMembership.upsert({
      where: { userId },
      create: { userId, tierId: earnedTier.id, totalSpentSnap: totalSpent },
      update: {
        tierId: earnedTier.id,
        totalSpentSnap: totalSpent,
        achievedAt: new Date(),
      },
    });

    // Thưởng khi lên hạng mới (chỉ upgrade, không thưởng khi bị hạ hạng)
    // skipBonuses = true khi gọi từ admin (recalculateAllVip) để tránh thưởng hàng loạt
    if (isUpgrade && !skipBonuses) {
      const bonusQH = earnedTier.bonusQuanHuy || 0;
      const spinBonusCount = earnedTier.spinBonus || 0;
      const rewardParts = [];

      // 1. Thưởng Quân Huy
      if (bonusQH > 0) {
        await prisma.user.update({
          where: { id: userId },
          data: { quanHuyBalance: { increment: bonusQH } },
        });
        await prisma.quanHuyTransaction.create({
          data: {
            userId,
            amount: bonusQH,
            balanceBefore: user.quanHuyBalance,
            balanceAfter: user.quanHuyBalance + bonusQH,
            type: "VIP_BONUS",
            description: `Thưởng ${bonusQH} Quân Huy khi đạt hạng ${earnedTier.name}`,
          },
        });
        rewardParts.push(`+${bonusQH} Quân Huy`);
      }

      // 2. Thưởng lượt quay (quy đổi thành tiền = spinBonus * spinCost của wheel)
      let spinValue = 0;
      if (spinBonusCount > 0) {
        const wheel = await prisma.luckyWheel.findFirst({
          where: { isActive: true },
        });
        if (wheel) {
          spinValue = Math.round(spinBonusCount * parseFloat(wheel.spinCost));
          if (spinValue > 0) {
            const freshUser = await prisma.user.findUnique({
              where: { id: userId },
              select: { balance: true },
            });
            await prisma.user.update({
              where: { id: userId },
              data: { balance: { increment: spinValue } },
            });
            await prisma.transaction.create({
              data: {
                userId,
                type: "VIP_BONUS",
                amount: spinValue,
                balanceBefore: freshUser.balance,
                balanceAfter: parseFloat(freshUser.balance) + spinValue,
                description: `Thưởng ${spinBonusCount} lượt quay (${spinValue.toLocaleString("vi-VN")}đ) khi đạt hạng ${earnedTier.name}`,
              },
            });
            rewardParts.push(
              `+${spinValue.toLocaleString("vi-VN")}đ (${spinBonusCount} lượt quay)`,
            );
          }
        }
      }

      // 3. Thông báo lên hạng VIP
      const tierUpMessage =
        rewardParts.length > 0
          ? `Chúc mừng bạn đã đạt hạng ${earnedTier.name}! Quà tặng: ${rewardParts.join(", ")}.`
          : `Chúc mừng bạn đã đạt hạng ${earnedTier.name}! Bạn được hưởng các ưu đãi giảm giá VIP.`;

      await prisma.notification.create({
        data: {
          userId,
          type: "VIP",
          title: `🎉 Lên hạng ${earnedTier.name}!`,
          message: tierUpMessage,
          data: {
            tierId: earnedTier.id,
            tierName: earnedTier.name,
            tierColor: earnedTier.color,
            bonusQuanHuy: bonusQH,
            spinBonus: spinBonusCount,
            spinValue,
          },
        },
      });

      emitToUser(userId, "notification", {
        type: "VIP",
        title: `🎉 Lên hạng ${earnedTier.name}!`,
        message: tierUpMessage,
      });
    }
  } catch (err) {
    console.error("recalculateVip error:", err);
  }
};

// Helper: lấy % giảm giá VIP hiện tại của 1 user theo từng loại (acc / túi mù / thẻ)
// Dùng ở account.controller (mua acc), mysteryBoxCategory.controller (mở túi mù), card.controller (mua thẻ)
const getUserVipDiscounts = async (userId) => {
  try {
    const membership = await prisma.vipMembership.findUnique({
      where: { userId },
      include: { tier: true },
    });
    if (!membership || !membership.tier || !membership.tier.isActive) {
      return { accPercent: 0, boxPercent: 0, cardPercent: 0, tier: null };
    }
    return {
      accPercent: parseFloat(membership.tier.discountPercent || 0),
      boxPercent: parseFloat(membership.tier.discountBoxPercent || 0),
      cardPercent: parseFloat(membership.tier.discountCardPercent || 0),
      wheelPercent: parseFloat(membership.tier.discountWheelPercent || 0),
      tier: membership.tier,
    };
  } catch (err) {
    console.error("getUserVipDiscounts error:", err);
    return {
      accPercent: 0,
      boxPercent: 0,
      cardPercent: 0,
      wheelPercent: 0,
      tier: null,
    };
  }
};

// Admin: CRUD VIP tiers
// Helper: recalculate VIP cho TẤT CẢ user có totalSpent > 0
// Gọi sau khi admin thay đổi tier (create/update/delete)
const recalculateAllVip = async () => {
  try {
    const users = await prisma.user.findMany({
      where: { totalSpent: { gt: 0 } },
      select: { id: true },
    });
    await Promise.all(
      users.map((u) => recalculateVip(u.id, { skipBonuses: true })),
    );
  } catch (err) {
    console.error("recalculateAllVip error:", err);
  }
};

const adminCreateTier = async (req, res) => {
  try {
    const {
      name,
      minSpent,
      discountPercent,
      discountBoxPercent,
      discountCardPercent,
      discountWheelPercent,
      bonusQuanHuy,
      spinBonus,
      color,
      icon,
      sortOrder,
    } = req.body;
    const tier = await prisma.vipTier.create({
      data: {
        name,
        minSpent: parseFloat(minSpent),
        discountPercent: parseFloat(discountPercent || 0),
        discountBoxPercent: parseFloat(discountBoxPercent || 0),
        discountCardPercent: parseFloat(discountCardPercent || 0),
        discountWheelPercent: parseFloat(discountWheelPercent || 0),
        bonusQuanHuy: parseInt(bonusQuanHuy || 0),
        spinBonus: parseInt(spinBonus || 0),
        color,
        icon,
        sortOrder: parseInt(sortOrder || 0),
      },
    });
    // Recalculate VIP cho tất cả user (vì tier mới có thể áp dụng cho user đã đủ điều kiện)
    await recalculateAllVip();
    res.json({ success: true, data: tier });
  } catch (err) {
    console.error("adminCreateTier error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const adminUpdateTier = async (req, res) => {
  try {
    const tier = await prisma.vipTier.update({
      where: { id: req.params.id },
      data: req.body,
    });
    // Recalculate VIP cho tất cả user (vì minSpent có thể đã thay đổi)
    await recalculateAllVip();
    res.json({ success: true, data: tier });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const adminDeleteTier = async (req, res) => {
  try {
    await prisma.vipTier.delete({ where: { id: req.params.id } });
    // Recalculate VIP cho tất cả user (vì tier bị xóa → user cần hạ/xóa hạng)
    await recalculateAllVip();
    res.json({ success: true, message: "Đã xóa tier" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const adminGetMembers = async (req, res) => {
  try {
    const { tierId, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const where = tierId ? { tierId } : {};

    const [total, members] = await Promise.all([
      prisma.vipMembership.count({ where }),
      prisma.vipMembership.findMany({
        where,
        include: {
          tier: true,
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              email: true,
              totalSpent: true,
            },
          },
        },
        orderBy: {
          achievedAt: "desc",
        },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    res.json({
      success: true,
      data: {
        members,
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("adminGetMembers error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Lỗi lấy thành viên VIP",
    });
  }
};

module.exports = {
  getVipTiers,
  getMyVip,
  recalculateVip,
  getUserVipDiscounts,
  adminCreateTier,
  adminUpdateTier,
  adminDeleteTier,
  adminGetMembers,
};
