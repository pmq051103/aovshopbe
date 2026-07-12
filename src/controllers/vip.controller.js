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

    // nextTier = hạng NGAY SAU hạng hiện tại (theo thứ hạng minSpent), KHÔNG phải theo totalSpent.
    // Lý do: nếu admin gán tay hạng cao nhất cho user, totalSpent thực tế của họ có thể vẫn thấp
    // hơn minSpent của 1 hạng thấp hơn → nếu tính theo totalSpent sẽ nhầm hiển thị "hạng tiếp theo"
    // là 1 hạng THẤP HƠN hạng đang có, gây tính toán vô lý. Tính theo thứ hạng thì luôn đúng:
    // đã ở hạng cao nhất → không còn hạng tiếp theo, dù totalSpent bao nhiêu.
    let nextTier = null;
    if (membership) {
      const idx = tiers.findIndex((t) => t.id === membership.tierId);
      if (idx !== -1 && idx < tiers.length - 1) nextTier = tiers[idx + 1];
      // idx === tiers.length - 1 → đã ở hạng cao nhất, nextTier giữ nguyên null
    } else {
      // Chưa có hạng nào → hạng tiếp theo cần hướng tới là hạng thấp nhất chưa đạt được
      nextTier = tiers.find((t) => parseFloat(t.minSpent) > currentTotalSpent) || null;
    }

    let progressToNext = 100;
    if (nextTier) {
      const range = parseFloat(nextTier.minSpent) - currentMinSpent;
      progressToNext =
        range > 0 ? ((currentTotalSpent - currentMinSpent) / range) * 100 : 100;
      // Kẹp về khoảng 0–100 (VD: hạng hiện tại được gán tay cao hơn mức chi tiêu thực tế
      // → currentTotalSpent < currentMinSpent → progress sẽ ra số âm nếu không kẹp lại)
      progressToNext = Math.max(0, Math.min(100, progressToNext));
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

// Helper: tặng thưởng (bonusQuanHuy + spinBonus) khi user đạt 1 hạng VIP — CHỈ 1 LẦN DUY NHẤT
// cho mỗi cặp (user, hạng), dùng bảng VipBonusClaim để theo dõi.
// Nếu user từng nhận thưởng của hạng này rồi (kể cả sau khi bị mất hạng rồi lên lại,
// dù tự động hay do admin gán tay) → sẽ KHÔNG được thưởng lại.
// Trả về { granted, rewardParts } để nơi gọi ghép vào nội dung thông báo.
const grantVipTierBonusOnce = async (userId, tier) => {
  try {
    // Tạo bản ghi "đã nhận" trước — nếu đã tồn tại (unique userId+tierId) sẽ ném lỗi P2002
    await prisma.vipBonusClaim.create({ data: { userId, tierId: tier.id } });
  } catch (err) {
    if (err.code === "P2002") return { granted: false, rewardParts: [] }; // đã nhận trước đó rồi
    throw err;
  }

  const rewardParts = [];
  const bonusQH = tier.bonusQuanHuy || 0;
  const spinBonusCount = tier.spinBonus || 0;

  // 1. Thưởng Quân Huy
  if (bonusQH > 0) {
    const freshUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { quanHuyBalance: true },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { quanHuyBalance: { increment: bonusQH } },
    });
    await prisma.quanHuyTransaction.create({
      data: {
        userId,
        amount: bonusQH,
        balanceBefore: freshUser.quanHuyBalance,
        balanceAfter: freshUser.quanHuyBalance + bonusQH,
        type: "VIP_BONUS",
        description: `Thưởng ${bonusQH} Quân Huy khi đạt hạng ${tier.name}`,
      },
    });
    rewardParts.push(`+${bonusQH} Quân Huy`);
  }

  // 2. Thưởng lượt quay (quy đổi thành tiền = spinBonus * spinCost của wheel)
  if (spinBonusCount > 0) {
    const wheel = await prisma.luckyWheel.findFirst({ where: { isActive: true } });
    if (wheel) {
      const spinValue = Math.round(spinBonusCount * parseFloat(wheel.spinCost));
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
            description: `Thưởng ${spinBonusCount} lượt quay (${spinValue.toLocaleString("vi-VN")}đ) khi đạt hạng ${tier.name}`,
          },
        });
        rewardParts.push(`+${spinValue.toLocaleString("vi-VN")}đ (${spinBonusCount} lượt quay)`);
      }
    }
  }

  return { granted: true, rewardParts };
};

// Helper: tính và cập nhật VIP cho 1 user dựa trên totalSpent hiện tại.
// Gọi từ: mua hàng (account/card/box), và getMyVip (để luôn đồng bộ khi admin đổi tier).
const recalculateVip = async (userId, { skipBonuses = false } = {}) => {
  try {
    const existing = await prisma.vipMembership.findUnique({
      where: { userId },
    });

    // Nếu admin đã gán tay hạng VIP cho user này, không tự động tính lại nữa
    // (chỉ admin mới có thể thay đổi hoặc gỡ bỏ, xem adminSetUserTier bên dưới)
    if (existing?.isManual) return;

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
    // grantVipTierBonusOnce tự đảm bảo không thưởng trùng nếu user đã từng nhận thưởng hạng này rồi
    if (isUpgrade && !skipBonuses) {
      const { rewardParts } = await grantVipTierBonusOnce(userId, earnedTier);

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
      return { accPercent: 0, boxPercent: 0, cardPercent: 0, wheelPercent: 0, phoneTopupPercent: 0, tier: null };
    }
    return {
      accPercent: parseFloat(membership.tier.discountPercent || 0),
      boxPercent: parseFloat(membership.tier.discountBoxPercent || 0),
      cardPercent: parseFloat(membership.tier.discountCardPercent || 0),
      wheelPercent: parseFloat(membership.tier.discountWheelPercent || 0),
      phoneTopupPercent: parseFloat(membership.tier.discountPhoneTopupPercent || 0),
      tier: membership.tier,
    };
  } catch (err) {
    console.error("getUserVipDiscounts error:", err);
    return {
      accPercent: 0,
      boxPercent: 0,
      cardPercent: 0,
      wheelPercent: 0,
      phoneTopupPercent: 0,
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

// Helper: giới hạn % giảm giá trong khoảng 0–100 (tránh admin nhập nhầm số âm hoặc >100%,
// vốn có thể khiến giá sau chiết khấu bị âm khi cộng dồn với các loại giảm giá khác)
const clampPercent = (value, fallback = 0) => {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(100, Math.max(0, n));
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
      discountPhoneTopupPercent,
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
        discountPercent: clampPercent(discountPercent),
        discountBoxPercent: clampPercent(discountBoxPercent),
        discountCardPercent: clampPercent(discountCardPercent),
        discountWheelPercent: clampPercent(discountWheelPercent),
        discountPhoneTopupPercent: clampPercent(discountPhoneTopupPercent),
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
    const data = { ...req.body };
    // Giới hạn lại các field % nếu có mặt trong request, tránh vượt 0–100
    ["discountPercent", "discountBoxPercent", "discountCardPercent", "discountWheelPercent", "discountPhoneTopupPercent"].forEach(
      (field) => {
        if (data[field] !== undefined) data[field] = clampPercent(data[field]);
      },
    );

    const tier = await prisma.vipTier.update({
      where: { id: req.params.id },
      data,
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
    const { tierId, search, page = 1, limit = 20 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const where = {};
    if (tierId && tierId !== "ALL") where.tierId = tierId;

    if (search && search.trim()) {
      where.user = {
        OR: [
          { username: { contains: search.trim() } },
          { displayName: { contains: search.trim() } },
          { email: { contains: search.trim() } },
        ],
      };
    }

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

// Admin: gán tay hạng VIP cho 1 user cụ thể (ghi đè tính toán tự động theo totalSpent)
// body: { tierId, grantBonus } — truyền tierId = null/"" để gỡ ghi đè, trả lại về tính tự động theo totalSpent
// grantBonus = true → tặng thưởng Quân Huy/lượt quay của hạng đó (chỉ nếu user CHƯA từng nhận thưởng hạng này trước đây)
const adminSetUserTier = async (req, res) => {
  try {
    const { userId } = req.params;
    const { tierId, grantBonus = false } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, totalSpent: true },
    });
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy người dùng" });

    // Gỡ ghi đè → xóa membership hiện tại rồi tính lại tự động theo totalSpent
    if (!tierId) {
      const existing = await prisma.vipMembership.findUnique({
        where: { userId },
      });
      if (existing) {
        await prisma.vipMembership.delete({ where: { userId } });
      }
      await recalculateVip(userId, { skipBonuses: true });

      const membership = await prisma.vipMembership.findUnique({
        where: { userId },
        include: { tier: true },
      });

      await prisma.notification.create({
        data: {
          userId,
          type: "VIP",
          title: "Cập nhật hạng VIP",
          message: "Admin đã gỡ hạng VIP gán tay của bạn, hạng VIP hiện được tính lại tự động theo tổng chi tiêu.",
        },
      });
      emitToUser(userId, "notification", {
        type: "VIP",
        title: "Cập nhật hạng VIP",
        message: "Admin đã gỡ hạng VIP gán tay của bạn, hạng VIP hiện được tính lại tự động theo tổng chi tiêu.",
      });

      return res.json({
        success: true,
        message: "Đã gỡ ghi đè, hạng VIP được tính lại tự động theo chi tiêu",
        data: membership,
      });
    }

    const tier = await prisma.vipTier.findUnique({ where: { id: tierId } });
    if (!tier)
      return res
        .status(404)
        .json({ success: false, message: "Không tìm thấy cấp VIP" });

    const membership = await prisma.vipMembership.upsert({
      where: { userId },
      create: {
        userId,
        tierId,
        totalSpentSnap: parseFloat(user.totalSpent),
        isManual: true,
        setBy: req.user.id,
      },
      update: {
        tierId,
        totalSpentSnap: parseFloat(user.totalSpent),
        achievedAt: new Date(),
        isManual: true,
        setBy: req.user.id,
      },
      include: { tier: true },
    });

    // Tuỳ chọn tặng thưởng — chỉ tặng nếu admin tick chọn VÀ user chưa từng nhận thưởng hạng này
    let rewardParts = [];
    let alreadyClaimedBefore = false;
    if (grantBonus) {
      const result = await grantVipTierBonusOnce(userId, tier);
      rewardParts = result.rewardParts;
      alreadyClaimedBefore = !result.granted;
    }

    // Luôn gửi thông báo cho user khi admin gán tay hạng VIP
    const message =
      rewardParts.length > 0
        ? `🎉 Admin đã cập nhật hạng VIP của bạn thành ${tier.name}! Quà tặng: ${rewardParts.join(", ")}.`
        : `🎉 Admin đã cập nhật hạng VIP của bạn thành ${tier.name}.`;

    await prisma.notification.create({
      data: {
        userId,
        type: "VIP",
        title: "Cập nhật hạng VIP",
        message,
        data: { tierId: tier.id, tierName: tier.name, manual: true },
      },
    });
    emitToUser(userId, "notification", {
      type: "VIP",
      title: "Cập nhật hạng VIP",
      message,
    });

    let responseMessage = `Đã gán hạng ${tier.name} cho người dùng`;
    if (grantBonus) {
      responseMessage = alreadyClaimedBefore
        ? `${responseMessage} (không tặng thưởng vì người dùng đã từng nhận thưởng của hạng này trước đây)`
        : `${responseMessage} và đã tặng thưởng`;
    }

    res.json({
      success: true,
      message: responseMessage,
      data: membership,
    });
  } catch (err) {
    console.error("adminSetUserTier error:", err);
    res.status(500).json({ success: false, message: err.message });
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
  adminSetUserTier,
};