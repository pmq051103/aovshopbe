/**
 * chatTools.service.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tool System cho AI Chatbot — tất cả tools đều query MySQL/Prisma trực tiếp.
 * Dữ liệu động KHÔNG bao giờ đi qua Pinecone.
 *
 * Định nghĩa tool theo format Gemini Function Calling.
 * Bot tự quyết định gọi tool nào, khi nào.
 * ─────────────────────────────────────────────────────────────────────────
 */
const prisma = require('../config/prisma')
const logger = require('../config/logger')

const PHONE_TELCOS = ['VIETTEL', 'VINAPHONE', 'MOBIFONE', 'VIETNAMOBILE', 'GMOBILE', 'REDDI']

/* ══════════════════════════════════════════════════════════
   TOOL DEFINITIONS — Gemini Function Calling format
   ══════════════════════════════════════════════════════════ */
const TOOL_DECLARATIONS = [
  {
    name: 'search_accounts',
    description: 'Tìm kiếm acc Liên Quân Mobile trong shop theo các tiêu chí: giá, rank, số skin, số tướng, server, liên kết, và theo TÊN TƯỚNG hoặc TÊN SKIN. Gọi khi user muốn tìm/xem/mua acc. Nếu user nói "acc có skin/tướng <tên>" (vd: "skin Triệu Vân", "tướng Murad") thì truyền tên đó vào heroName (nếu là tên tướng) hoặc skinName (nếu là tên skin cụ thể) — có thể truyền cả 2. Hỗ trợ acc trắng/chưa liên kết/chỉ SĐT/chỉ email.',
    parameters: {
      type: 'object',
      properties: {
        rank: { type: 'string', description: 'Rank acc: Đồng|Bạc|Vàng|Bạch Kim|Kim Cương|Cao Thủ|Chiến Tướng|Thách Đấu' },
        minPrice: { type: 'number', description: 'Giá tối thiểu (VND)' },
        maxPrice: { type: 'number', description: 'Giá tối đa (VND)' },
        minSkins: { type: 'number', description: 'Số skin tối thiểu' },
        maxSkins: { type: 'number', description: 'Số skin tối đa' },
        minChampions: { type: 'number', description: 'Số tướng tối thiểu' },
        skinName: { type: 'string', description: 'Tên SKIN cụ thể cần tìm (vd: "Nguyệt Quang", "Quan Vũ Tinh Anh"). Nếu chỉ biết tên tướng thì dùng heroName.' },
        heroName: { type: 'string', description: 'Tên TƯỚNG cần tìm (vd: "Triệu Vân", "Murad", "Lôi"). Tìm acc có bất kỳ skin nào của tướng này.' },
        server: { type: 'string', description: 'Server acc' },
        gameBindFacebook: { type: 'string', description: 'Trạng thái liên kết FB: LIVE|RIP|NONE. NONE nghĩa là không liên kết Facebook' },
        hasEmail: { type: 'boolean', description: 'Có liên kết email không. false nghĩa là không có email' },
        hasPhone: { type: 'boolean', description: 'Có liên kết SĐT không. false nghĩa là không có số điện thoại' },
        bindFilter: {
          type: 'string',
          description: 'Lọc nhanh trạng thái liên kết: WHITE = acc trắng/chưa liên kết email, SĐT, FB; PHONE_ONLY = chỉ có SĐT, không email, không FB; EMAIL_ONLY = chỉ có email, không SĐT, không FB; WHITE_OR_PHONE = acc trắng hoặc chỉ có SĐT',
        },
        isFeatured: { type: 'boolean', description: 'Chỉ lấy acc nổi bật' },
        sort: { type: 'string', description: 'Sắp xếp: newest|price_asc|price_desc|popular|skins_desc|champions_desc' },
        limit: { type: 'number', description: 'Số lượng kết quả, tối đa 8' },
      },
    },
  },
  {
    name: 'get_account_detail',
    description: 'Lấy thông tin chi tiết một acc cụ thể theo ID hoặc mã code. Gọi khi user hỏi về một acc cụ thể.',
    parameters: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'ID của acc' },
        accountCode: { type: 'string', description: 'Mã code của acc (vd: AOV123)' },
      },
    },
  },
  {
    name: 'get_deposit_history',
    description: 'Lấy lịch sử nạp tiền của user hiện tại. Gọi khi user hỏi về giao dịch nạp tiền, lịch sử nạp, giao dịch đang chờ.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Lọc theo trạng thái: PENDING|COMPLETED|FAILED|EXPIRED' },
        limit: { type: 'number', description: 'Số lượng, tối đa 10' },
      },
    },
  },
  {
    name: 'get_order_history',
    description: 'Lấy lịch sử mua acc của user hiện tại. Gọi khi user hỏi về đơn hàng, acc đã mua.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Số lượng, tối đa 10' },
      },
    },
  },
  {
    name: 'get_card_purchase_history',
    description: 'Lấy lịch sử mua thẻ điện thoại/thẻ game của user. Gọi khi user hỏi về thẻ đã mua, lịch sử mua thẻ.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Số lượng, tối đa 10' },
      },
    },
  },
  {
    name: 'get_mystery_box_info',
    description: 'Lấy thông tin các loại túi mù (mystery box) đang có. Gọi khi user hỏi về túi mù.',
    parameters: {
      type: 'object',
      properties: {
        rarity: { type: 'string', description: 'Độ hiếm: COMMON|RARE|EPIC|LEGENDARY' },
        maxPrice: { type: 'number', description: 'Giá tối đa (VND)' },
        limit: { type: 'number', description: 'Số lượng, tối đa 8' },
      },
    },
  },
  {
    name: 'get_wheel_info',
    description: 'Lấy thông tin vòng quay may mắn đang active. Gọi khi user hỏi về vòng quay, quay thưởng.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_ranking',
    description: 'Lấy bảng xếp hạng nạp tiền. Gọi khi user hỏi về BXH, top nạp, ai nạp nhiều nhất.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Số lượng top, tối đa 10' },
      },
    },
  },
  {
    name: 'get_card_config',
    description:
      'Lấy DANH SÁCH các loại thẻ shop bán/nạp và cấu hình chiết khấu theo loại thẻ & mệnh giá. Gọi khi user hỏi: shop bán/nạp những thẻ gì, có loại thẻ nào, hoặc nạp/mua thẻ có chiết khấu không, nhận/giá bao nhiêu. Bỏ trống telco để lấy toàn bộ loại thẻ đang có (đọc trường "telcos").',
    parameters: {
      type: 'object',
      properties: {
        telco: {
          type: 'string',
          description: 'Loại thẻ: VIETTEL, VINAPHONE, MOBIFONE, ZING, GATE, GARENA...',
        },
        denomination: {
          type: 'number',
          description: 'Mệnh giá thẻ, ví dụ 10000, 50000, 100000',
        },
      },
    },
  },
  {
    name: 'search_auctions',
    description:
      'Tìm các phòng đấu giá acc Liên Quân (đang mở/sắp diễn ra/đã kết thúc). Gọi khi user hỏi về đấu giá, phòng đấu giá, acc đang đấu giá, sắp đấu giá, ai đang thắng, giá hiện tại.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Trạng thái phòng: SCHEDULED (sắp diễn ra) | ACTIVE (đang nhận bid) | ENDED (đã kết thúc). Không truyền = lấy SCHEDULED và ACTIVE.',
        },
        limit: { type: 'number', description: 'Số lượng kết quả, tối đa 10' },
      },
    },
  },
  {
    name: 'get_auction_detail',
    description:
      'Lấy chi tiết một phòng đấu giá cụ thể: giá hiện tại, người đang giữ giá, bước giá, thời gian kết thúc, lịch sử bid gần nhất. Gọi khi user hỏi về một phòng đấu giá cụ thể hoặc hỏi tiếp về phòng vừa nhắc.',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'ID của phòng đấu giá' },
        title: { type: 'string', description: 'Tên/tiêu đề phòng đấu giá để tìm gần đúng nếu không có ID' },
      },
    },
  },
  {
    name: 'search_marketplace',
    description:
      'Tìm tin đăng bán acc trên chợ trao đổi (marketplace P2P giữa user với nhau, khác với acc shop bán trực tiếp). Gọi khi user hỏi về chợ trao đổi, tin đăng bán acc của người khác, acc ký gửi, mua acc từ người bán khác.',
    parameters: {
      type: 'object',
      properties: {
        minPrice: { type: 'number', description: 'Giá tối thiểu (VND)' },
        maxPrice: { type: 'number', description: 'Giá tối đa (VND)' },
        hasFullInfo: { type: 'boolean', description: 'true = chỉ lấy tin acc có bind info (email/sđt/fb)' },
        keyword: { type: 'string', description: 'Từ khóa tìm trong tiêu đề tin đăng' },
        limit: { type: 'number', description: 'Số lượng kết quả, tối đa 10' },
      },
    },
  },
  {
    name: 'get_marketplace_listing_detail',
    description:
      'Lấy chi tiết một tin đăng cụ thể trên chợ trao đổi: giá, mô tả, thông tin liên hệ người bán, trạng thái duyệt. Gọi khi user hỏi về một tin đăng cụ thể trên chợ trao đổi.',
    parameters: {
      type: 'object',
      properties: {
        listingId: { type: 'string', description: 'ID của tin đăng' },
      },
    },
  },
]

/* ══════════════════════════════════════════════════════════
   TOOL EXECUTORS — Thực thi tool calls
   ══════════════════════════════════════════════════════════ */

async function execSearchAccounts(args) {
  try {
    const {
      rank,
      minPrice,
      maxPrice,
      minSkins,
      maxSkins,
      minChampions,
      skinName,
      heroName,
      server,
      gameBindFacebook,
      hasEmail,
      hasPhone,
      bindFilter,
      isFeatured,
      sort,
      limit = 5,
    } = args

    const where = {
      status: 'AVAILABLE',
    }

    const emptyEmail = {
      OR: [
        { gameBindEmail: null },
        { gameBindEmail: '' },
      ],
    }

    const hasEmailValue = {
      AND: [
        { gameBindEmail: { not: null } },
        { gameBindEmail: { not: '' } },
      ],
    }

    const emptyPhone = {
      OR: [
        { gameBindPhone: null },
        { gameBindPhone: '' },
      ],
    }

    const hasPhoneValue = {
      AND: [
        { gameBindPhone: { not: null } },
        { gameBindPhone: { not: '' } },
      ],
    }

    const emptyFacebook = {
      gameBindFacebook: 'NONE',
    }

    if (rank) where.rank = rank
    if (server) where.server = server
    if (isFeatured) where.isFeatured = true

    const normalizedBindFilter = bindFilter
      ? String(bindFilter).trim().toUpperCase()
      : null

    if (normalizedBindFilter === 'WHITE') {
      where.AND = [
        ...(where.AND || []),
        emptyEmail,
        emptyPhone,
        emptyFacebook,
      ]
    } else if (normalizedBindFilter === 'PHONE_ONLY') {
      where.AND = [
        ...(where.AND || []),
        emptyEmail,
        hasPhoneValue,
        emptyFacebook,
      ]
    } else if (normalizedBindFilter === 'EMAIL_ONLY') {
      where.AND = [
        ...(where.AND || []),
        hasEmailValue,
        emptyPhone,
        emptyFacebook,
      ]
    } else if (normalizedBindFilter === 'WHITE_OR_PHONE') {
      where.AND = [
        ...(where.AND || []),
        emptyEmail,
        emptyFacebook,
        {
          OR: [
            emptyPhone,
            hasPhoneValue,
          ],
        },
      ]
    } else {
      if (hasEmail === true) {
        where.AND = [
          ...(where.AND || []),
          hasEmailValue,
        ]
      } else if (hasEmail === false) {
        where.AND = [
          ...(where.AND || []),
          emptyEmail,
        ]
      }

      if (hasPhone === true) {
        where.AND = [
          ...(where.AND || []),
          hasPhoneValue,
        ]
      } else if (hasPhone === false) {
        where.AND = [
          ...(where.AND || []),
          emptyPhone,
        ]
      }
      if (gameBindFacebook) {
        where.gameBindFacebook = String(gameBindFacebook).toUpperCase()
      }
    }

    if (minPrice || maxPrice) {
      where.price = {}
      if (minPrice) where.price.gte = Number(minPrice)
      if (maxPrice) where.price.lte = Number(maxPrice)
    }

    if (minSkins || maxSkins) {
      where.skins = {}
      if (minSkins) where.skins.gte = Number(minSkins)
      if (maxSkins) where.skins.lte = Number(maxSkins)
    }

    if (minChampions) {
      where.champions = {
        gte: Number(minChampions),
      }
    }

    // Tìm theo skin/tướng: khớp CẢ skinName LẪN heroName vì user (và AI) hay lẫn
    // giữa tên tướng và tên skin. Vd "skin Triệu Vân" — Triệu Vân là TƯỚNG, các skin
    // của nó có tên khác (Nguyệt Quang...), nên nếu chỉ tìm skinName sẽ bị sót/sai.
    const skinKw = skinName ? String(skinName).trim() : ''
    const heroKw = heroName ? String(heroName).trim() : ''
    const skinConds = []
    if (skinKw) {
      skinConds.push({ skinName: { contains: skinKw } })
      skinConds.push({ heroName: { contains: skinKw } })
    }
    if (heroKw && heroKw.toLowerCase() !== skinKw.toLowerCase()) {
      skinConds.push({ heroName: { contains: heroKw } })
      skinConds.push({ skinName: { contains: heroKw } })
    }
    if (skinConds.length) {
      where.skins_rel = {
        some: { OR: skinConds },
      }
    }

    const orderByMap = {
      newest: { createdAt: 'desc' },
      price_asc: { price: 'asc' },
      price_desc: { price: 'desc' },
      popular: { viewCount: 'desc' },
      skins_desc: { skins: 'desc' },
      champions_desc: { champions: 'desc' },
    }

    const orderBy =
      sort && orderByMap[sort]
        ? orderByMap[sort]
        : { createdAt: 'desc' }

    const accounts = await prisma.gameAccount.findMany({
      where,
      orderBy,
      take: Math.min(Number(limit) || 5, 8),
      select: {
        id: true,
        code: true,
        title: true,
        rank: true,
        server: true,
        price: true,
        skins: true,
        champions: true,
        level: true,
        thumbnailUrl: true,
        isFeatured: true,
        isNew: true,
        gameBindEmail: true,
        gameBindPhone: true,
        gameBindFacebook: true,
        // Khi tìm theo skin/tướng: lấy kèm các skin KHỚP để AI xác nhận đúng acc
        ...(skinConds.length
          ? {
              skins_rel: {
                where: { OR: skinConds },
                select: { skinName: true, heroName: true },
                take: 8,
              },
            }
          : {}),
      },
    })

    return {
      count: accounts.length,
      accounts: accounts.map(a => ({
        id: a.id,
        code: a.code,
        title: a.title,
        rank: a.rank,
        server: a.server,
        price: Number(a.price),
        skins: a.skins,
        champions: a.champions,
        level: a.level,
        thumbnailUrl: a.thumbnailUrl,
        isFeatured: a.isFeatured,
        isNew: a.isNew,
        gameBindFacebook: a.gameBindFacebook,
        hasEmail: !!a.gameBindEmail,
        hasPhone: !!a.gameBindPhone,
        // Danh sách skin khớp với từ khoá tìm (nếu có) — giúp AI nói đúng tên skin
        ...(a.skins_rel
          ? {
              matchedSkins: a.skins_rel.map(s =>
                s.heroName ? `${s.skinName} (${s.heroName})` : s.skinName
              ),
            }
          : {}),
      })),
    }
  } catch (err) {
    logger.error('[Tool:search_accounts]', err)

    return {
      count: 0,
      accounts: [],
      error: err.message,
    }
  }
}

async function execGetAccountDetail(args, currentUserId) {
  try {
    const { accountId, accountCode } = args

    if (!accountId && !accountCode) {
      return { error: 'Cần cung cấp accountId hoặc accountCode' }
    }

    const normalizedCode = accountCode
      ? accountCode.toUpperCase().trim()
      : null

    // =========================
    // ACC SHOP THƯỜNG
    // =========================
    const gameWhere = {}

    if (accountId) gameWhere.id = accountId
    if (normalizedCode) gameWhere.code = normalizedCode

    const acc = await prisma.gameAccount.findFirst({
      where: gameWhere,
      include: {
        images: {
          orderBy: { sortOrder: 'asc' },
          take: 5,
        },
        categoryRelations: {
          include: {
            category: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    })

    if (acc) {
      const isOwner =
        acc.soldToId &&
        acc.soldToId === currentUserId

      // Acc đã bán cho người khác
      if (
        acc.status === 'SOLD' &&
        acc.soldToId &&
        !isOwner
      ) {
        return {
          error: 'ACCESS_DENIED',
          message: 'Acc này thuộc về người dùng khác',
        }
      }

      return {
        type: 'GAME_ACCOUNT',
        accountTypeLabel: 'Acc shop thường',

        id: acc.id,
        code: acc.code,
        title: acc.title,
        rank: acc.rank,
        server: acc.server,
        price: Number(acc.price),
        originalPrice: acc.originalPrice
          ? Number(acc.originalPrice)
          : null,

        status: acc.status,

        skins: acc.skins,
        champions: acc.champions,
        level: acc.level,
        gems: acc.gems,
        vouchers: acc.vouchers,
        winRate: acc.winRate
          ? Number(acc.winRate)
          : null,

        matches: acc.matches,

        // CHỈ CHỦ ACC MỚI THẤY
        gameUsername: isOwner
          ? acc.gameUsername
          : null,

        gamePassword: isOwner
          ? acc.gamePassword
          : null,

        gameBindEmail: isOwner
          ? acc.gameBindEmail
          : null,

        gameBindPhone: isOwner
          ? acc.gameBindPhone
          : null,

        gameBindFacebook: acc.gameBindFacebook,

        hasEmail: !!acc.gameBindEmail,
        hasPhone: !!acc.gameBindPhone,

        isFeatured: acc.isFeatured,
        isNew: acc.isNew,

        thumbnailUrl: acc.thumbnailUrl,
        description: acc.description,

        categories:
          acc.categoryRelations?.map(r => r.category) || [],

        images:
          acc.images?.map(i => i.url) || [],
      }
    }

    // =========================
    // ACC TÚI MÙ
    // =========================

    const mysteryWhere = {}

    if (accountId) mysteryWhere.id = accountId
    if (normalizedCode) mysteryWhere.code = normalizedCode

    const mysteryAcc =
      await prisma.mysteryBoxAccount.findFirst({
        where: mysteryWhere,
        include: {
          category: true,
          owner: {
            select: {
              id: true,
              username: true,
              displayName: true,
            },
          },
          openHistories: {
            orderBy: {
              createdAt: 'desc',
            },
            take: 1,
          },
        },
      })

    if (!mysteryAcc) {
      return {
        error: normalizedCode
          ? `Không tìm thấy acc có mã ${normalizedCode}`
          : 'Không tìm thấy acc',
      }
    }

    const isOwner =
      mysteryAcc.ownerId &&
      mysteryAcc.ownerId === currentUserId

    // Túi mù đã mở bởi người khác
    if (
      mysteryAcc.isSold &&
      mysteryAcc.ownerId &&
      !isOwner
    ) {
      return {
        error: 'ACCESS_DENIED',
        message: 'Acc này thuộc về người dùng khác',
      }
    }

    return {
      type: 'MYSTERY_BOX_ACCOUNT',
      accountTypeLabel: 'Acc túi mù',

      id: mysteryAcc.id,
      code: mysteryAcc.code,

      title: mysteryAcc.category?.name
        ? `${mysteryAcc.category.name} - ${mysteryAcc.code}`
        : mysteryAcc.code,

      status: mysteryAcc.status,

      isSold: mysteryAcc.isSold,
      soldAt: mysteryAcc.soldAt,

      ownerId: mysteryAcc.ownerId,

      ownerUsername:
        mysteryAcc.owner?.displayName ||
        mysteryAcc.owner?.username ||
        null,

      // CHỈ CHỦ ACC THẤY
      gameUsername: isOwner
        ? mysteryAcc.gameUsername
        : null,

      gamePassword: isOwner
        ? mysteryAcc.gamePassword
        : null,

      gameBindInfo: isOwner
        ? mysteryAcc.gameBindInfo
        : null,

      rarity: mysteryAcc.rarity,

      categoryId: mysteryAcc.categoryId,
      categoryName: mysteryAcc.category?.name || null,
      categorySlug: mysteryAcc.category?.slug || null,

      categoryRarity:
        mysteryAcc.category?.rarity || null,

      categoryDescription:
        mysteryAcc.category?.description || null,

      price: mysteryAcc.category?.price
        ? Number(mysteryAcc.category.price)
        : 0,

      thumbnailUrl:
        mysteryAcc.category?.thumbnail ||
        mysteryAcc.category?.detailImage ||
        mysteryAcc.category?.bannerImage ||
        null,

      description:
        mysteryAcc.category?.description || null,

      images: [
        mysteryAcc.category?.thumbnail,
        mysteryAcc.category?.bannerImage,
        mysteryAcc.category?.detailImage,
      ].filter(Boolean),
    }
  } catch (err) {
    logger.error('[Tool:get_account_detail]', err)

    return {
      error: err.message,
    }
  }
}

async function execGetCardConfig(args = {}) {
  try {
    const telco = args.telco ? String(args.telco).toUpperCase().trim() : null
    const denomination = args.denomination ? Number(args.denomination) : null

    const where = {}

    if (telco) {
      where.telco = telco
    }

    if (denomination) {
      where.denomination = denomination
    }

    const configs = await prisma.cardConfig.findMany({
      where,
      orderBy: [
        { telco: 'asc' },
        { denomination: 'asc' },
      ],
      take: telco && denomination ? 1 : 30,
      select: {
        id: true,
        telco: true,
        telcoLabel: true,
        denomination: true,
        depositEnabled: true,
        depositDiscount: true,
        buyEnabled: true,
        buyDiscount: true,
      },
    })

    if (!configs.length) {
      return {
        found: false,
        message: telco && denomination
          ? `Không tìm thấy cấu hình ${telco} ${denomination}`
          : 'Không tìm thấy cấu hình thẻ nào',
        configs: [],
      }
    }

    // Danh sách loại thẻ (telco) phân biệt trùng — để AI liệt kê đúng "shop bán thẻ gì".
    const telcoSeen = new Set()
    const telcos = []
    for (const c of configs) {
      const label = c.telcoLabel || c.telco
      const key = label.toLowerCase()
      if (telcoSeen.has(key)) continue
      telcoSeen.add(key)
      telcos.push({
        telco: c.telco,
        telcoLabel: label,
        type: PHONE_TELCOS.includes(c.telco) ? 'Điện thoại' : 'Game',
      })
    }

    return {
      found: true,
      count: configs.length,
      telcos,
      cardShopUrl: '/card-shop',
      configs: configs.map(c => {
        const denom = Number(c.denomination)
        const depositDiscount = Number(c.depositDiscount || 0)
        const buyDiscount = Number(c.buyDiscount || 0)

        return {
          id: c.id,
          telco: c.telco,
          telcoLabel: c.telcoLabel || c.telco,
          type: PHONE_TELCOS.includes(c.telco) ? 'Điện thoại' : 'Game',
          denomination: denom,

          depositEnabled: c.depositEnabled,
          depositDiscount,
          depositReceive: c.depositEnabled
            ? Math.round(denom * (1 - depositDiscount / 100))
            : null,

          buyEnabled: c.buyEnabled,
          buyDiscount,
          buyPrice: c.buyEnabled
            ? Math.round(denom * (1 - buyDiscount / 100))
            : null,
        }
      }),
    }
  } catch (err) {
    logger.error('[Tool:get_card_config]', err)
    return { found: false, configs: [], error: err.message }
  }
}

async function execGetDepositHistory(userId, args) {
  try {
    const { status, limit = 5 } = args
    const where = { userId }
    if (status) where.status = status.toUpperCase()

    const deposits = await prisma.deposit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 10),
      select: {
        id: true,
        amount: true,
        status: true,
        createdAt: true,
        expiredAt: true,
        bankCode: true,
      },
    })

    return {
      count: deposits.length,
      deposits: deposits.map(d => ({
        id: d.id,
        amount: Number(d.amount),
        status: d.status,
        createdAt: d.createdAt,
        expiredAt: d.expiredAt,
        method: d.bankCode || 'PAYOS',
      })),
    }
  } catch (err) {
    logger.error('[Tool:get_deposit_history]', err)
    return { count: 0, deposits: [], error: err.message }
  }
}

async function execGetOrderHistory(userId, args) {
  try {
    const { limit = 5 } = args
    const orders = await prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 10),
      include: {
        items: {
          select: {
            gameAccountCode: true,
            gameAccountTitle: true,
            gameAccountRank: true,
            price: true,
          },
        },
      },
    })

    return {
      count: orders.length,
      orders: orders.map(o => ({
        id: o.id,
        orderCode: o.orderCode,
        status: o.status,
        finalAmount: Number(o.finalAmount),
        createdAt: o.createdAt,
        completedAt: o.completedAt,
        items: o.items.map(i => ({
          code: i.gameAccountCode,
          title: i.gameAccountTitle,
          rank: i.gameAccountRank,
          price: Number(i.price),
        })),
      })),
    }
  } catch (err) {
    logger.error('[Tool:get_order_history]', err)
    return { count: 0, orders: [], error: err.message }
  }
}

async function execGetCardPurchaseHistory(userId, args) {
  try {
    const { limit = 5 } = args
    const purchases = await prisma.cardPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 10),
      select: {
        id: true,
        telco: true,
        denomination: true,
        quantity: true,
        totalPrice: true,
        status: true,
        createdAt: true,
        cards: true,
      },
    })

    return {
      count: purchases.length,
      purchases: purchases.map(p => ({
        id: p.id,
        telco: p.telco,
        type: PHONE_TELCOS.includes(p.telco) ? 'Điện thoại' : 'Game',
        denomination: Number(p.denomination),
        quantity: p.quantity,
        totalPrice: Number(p.totalPrice),
        status: p.status,
        cardCount: Array.isArray(p.cards) ? p.cards.length : 0,
        createdAt: p.createdAt,
      })),
    }
  } catch (err) {
    logger.error('[Tool:get_card_purchase_history]', err)
    return { count: 0, purchases: [], error: err.message }
  }
}

async function execGetMysteryBoxInfo(args) {
  try {
    const { rarity, maxPrice, limit = 6 } = args
    const where = { isActive: true }
    if (rarity) where.rarity = rarity.toUpperCase()
    if (maxPrice) where.price = { lte: maxPrice }

    const categories = await prisma.mysteryBoxCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
      take: Math.min(limit, 8),
      include: {
        _count: { select: { accounts: { where: { isSold: false } } } },
      },
    })

    return {
      count: categories.length,
      mysteryBoxes: categories.map(c => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        price: Number(c.price),
        rarity: c.rarity,
        thumbnail: c.thumbnail,
        availableCount: c._count.accounts,
        description: c.description?.slice(0, 200),
      })),
    }
  } catch (err) {
    logger.error('[Tool:get_mystery_box_info]', err)
    return { count: 0, mysteryBoxes: [], error: err.message }
  }
}

async function execGetWheelInfo() {
  try {
    const wheel = await prisma.luckyWheel.findFirst({
      where: { isActive: true },
      include: {
        rewards: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
            rarity: true,
            probability: true,
            color: true,
          },
        },
      },
    })

    if (!wheel) return { available: false, message: 'Hiện chưa có vòng quay nào active' }

    return {
      available: true,
      wheel: {
        id: wheel.id,
        name: wheel.name,
        spinCost: Number(wheel.spinCost),
        rewards: wheel.rewards.map(r => ({
          id: r.id,
          name: r.name,
          type: r.type,
          value: Number(r.value),
          rarity: r.rarity,
          probability: Number(r.probability),
        })),
      },
    }
  } catch (err) {
    logger.error('[Tool:get_wheel_info]', err)
    return { available: false, error: err.message }
  }
}

async function execGetRanking(args) {
  try {
    const { limit = 10 } = args
    const now = new Date()
    const month = now.getMonth() + 1
    const year = now.getFullYear()
    const periodKey = `${year}-${String(month).padStart(2, '0')}`

    const rankings = await prisma.ranking.findMany({
      where: { periodKey },
      orderBy: { totalDeposit: 'desc' },
      take: Math.min(limit, 10),
      include: {
        user: { select: { username: true, displayName: true, avatar: true } },
      },
    })

    return {
      period: `${month}/${year}`,
      count: rankings.length,
      rankings: rankings.map((r, i) => ({
        rank: i + 1,
        username: r.user.displayName || r.user.username,
        totalDeposit: Number(r.totalDeposit),
      })),
    }
  } catch (err) {
    logger.error('[Tool:get_ranking]', err)
    return { count: 0, rankings: [], error: err.message }
  }
}

async function execSearchAuctions(args = {}) {
  try {
    const { status, limit = 8 } = args
    const normalizedStatus = status ? String(status).trim().toUpperCase() : null

    const where = normalizedStatus
      ? { status: normalizedStatus }
      : { status: { in: ['SCHEDULED', 'ACTIVE'] } }

    const rooms = await prisma.auctionRoom.findMany({
      where,
      orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }],
      take: Math.min(limit, 10),
      include: {
        gameAccount: {
          select: { code: true, title: true, rank: true, skins: true, champions: true },
        },
      },
    })

    return {
      count: rooms.length,
      auctions: rooms.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        scheduledAt: r.scheduledAt,
        startedAt: r.startedAt,
        endsAt: r.endsAt,
        startingPrice: Number(r.startingPrice),
        bidStep: Number(r.bidStep),
        currentPrice: r.currentPrice != null ? Number(r.currentPrice) : Number(r.startingPrice),
        totalBids: r.totalBids,
        account: r.gameAccount
          ? {
              code: r.gameAccount.code,
              title: r.gameAccount.title,
              rank: r.gameAccount.rank,
              skins: r.gameAccount.skins,
              champions: r.gameAccount.champions,
            }
          : null,
      })),
    }
  } catch (err) {
    logger.error('[Tool:search_auctions]', err)
    return { count: 0, auctions: [], error: err.message }
  }
}

async function execGetAuctionDetail(args = {}) {
  try {
    const { roomId, title } = args
    if (!roomId && !title) {
      return { found: false, message: 'Cần roomId hoặc title để tra cứu phòng đấu giá' }
    }

    const room = await prisma.auctionRoom.findFirst({
      where: roomId ? { id: roomId } : { title: { contains: title } },
      orderBy: { createdAt: 'desc' },
      include: {
        gameAccount: {
          select: { code: true, title: true, rank: true, skins: true, champions: true, server: true },
        },
        winner: { select: { username: true, displayName: true } },
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: { user: { select: { username: true, displayName: true } } },
        },
      },
    })

    if (!room) {
      return { found: false, message: 'Không tìm thấy phòng đấu giá phù hợp' }
    }

    return {
      found: true,
      id: room.id,
      title: room.title,
      description: room.description,
      status: room.status,
      scheduledAt: room.scheduledAt,
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      startingPrice: Number(room.startingPrice),
      bidStep: Number(room.bidStep),
      currentPrice: room.currentPrice != null ? Number(room.currentPrice) : Number(room.startingPrice),
      totalBids: room.totalBids,
      winner: room.winner ? (room.winner.displayName || room.winner.username) : null,
      account: room.gameAccount
        ? {
            code: room.gameAccount.code,
            title: room.gameAccount.title,
            rank: room.gameAccount.rank,
            skins: room.gameAccount.skins,
            champions: room.gameAccount.champions,
            server: room.gameAccount.server,
          }
        : null,
      recentBids: room.bids.map(b => ({
        username: b.user.displayName || b.user.username,
        amount: Number(b.amount),
        isWinning: b.isWinning,
        createdAt: b.createdAt,
      })),
    }
  } catch (err) {
    logger.error('[Tool:get_auction_detail]', err)
    return { found: false, error: err.message }
  }
}

async function execSearchMarketplace(args = {}) {
  try {
    const { minPrice, maxPrice, hasFullInfo, keyword, limit = 8 } = args

    const where = { status: 'APPROVED' }
    if (minPrice || maxPrice) {
      where.price = {}
      if (minPrice) where.price.gte = Number(minPrice)
      if (maxPrice) where.price.lte = Number(maxPrice)
    }
    if (hasFullInfo === true) where.hasFullInfo = true
    if (hasFullInfo === false) where.hasFullInfo = false
    if (keyword) where.title = { contains: keyword }

    const listings = await prisma.marketplaceListing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 10),
      include: {
        seller: { select: { username: true, displayName: true } },
      },
    })

    return {
      count: listings.length,
      listings: listings.map(l => ({
        id: l.id,
        title: l.title,
        price: Number(l.price),
        feePercent: Number(l.feePercent),
        hasFullInfo: l.hasFullInfo,
        seller: l.seller.displayName || l.seller.username,
        createdAt: l.createdAt,
      })),
    }
  } catch (err) {
    logger.error('[Tool:search_marketplace]', err)
    return { count: 0, listings: [], error: err.message }
  }
}

async function execGetMarketplaceListingDetail(args = {}) {
  try {
    const { listingId } = args
    if (!listingId) {
      return { found: false, message: 'Cần listingId để tra cứu tin đăng' }
    }

    const listing = await prisma.marketplaceListing.findUnique({
      where: { id: listingId },
      include: {
        seller: { select: { username: true, displayName: true } },
      },
    })

    if (!listing) {
      return { found: false, message: 'Không tìm thấy tin đăng này' }
    }

    // Chỉ lộ thông tin liên hệ khi tin đã được duyệt công khai (APPROVED)
    const isPublic = listing.status === 'APPROVED'

    return {
      found: true,
      id: listing.id,
      title: listing.title,
      description: listing.description,
      price: Number(listing.price),
      feePercent: Number(listing.feePercent),
      hasFullInfo: listing.hasFullInfo,
      status: listing.status,
      seller: listing.seller.displayName || listing.seller.username,
      contactInfo: isPublic ? listing.contactInfo : null,
      soldAt: listing.soldAt,
    }
  } catch (err) {
    logger.error('[Tool:get_marketplace_listing_detail]', err)
    return { found: false, error: err.message }
  }
}

/* ══════════════════════════════════════════════════════════
   DISPATCHER — Gọi đúng executor theo tên tool
   ══════════════════════════════════════════════════════════ */
async function executeTool(toolName, args, userId) {
  logger.info(`[Tool] Execute: ${toolName}`, { args })

  switch (toolName) {
    case 'search_accounts': return execSearchAccounts(args)
    case 'get_account_detail': return execGetAccountDetail(args, userId)
    case 'get_deposit_history': return execGetDepositHistory(userId, args)
    case 'get_order_history': return execGetOrderHistory(userId, args)
    case 'get_card_purchase_history': return execGetCardPurchaseHistory(userId, args)
    case 'get_mystery_box_info': return execGetMysteryBoxInfo(args)
    case 'get_wheel_info': return execGetWheelInfo()
    case 'get_ranking': return execGetRanking(args)
    case 'get_card_config': return execGetCardConfig(args)
    case 'search_auctions': return execSearchAuctions(args)
    case 'get_auction_detail': return execGetAuctionDetail(args)
    case 'search_marketplace': return execSearchMarketplace(args)
    case 'get_marketplace_listing_detail': return execGetMarketplaceListingDetail(args)
    default:
      return { error: `Tool "${toolName}" không tồn tại` }
  }
}

module.exports = { TOOL_DECLARATIONS, executeTool }