const prisma = require('../config/prisma')
const { emitToUser, emitToAll, emitToAdmins, getIO } = require('../config/socket')
const { checkAndGrantAchievements } = require('./achievement.controller')

const ROOM_INCLUDE_PUBLIC = {
  gameAccount: {
    include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } }
  }
}

// ── Public: danh sách phòng (thanh chạy ngang + list) ──────────────────────
// Trả về các phòng SCHEDULED (sắp diễn ra) + ACTIVE (đang đấu giá), mới nhất trước
const getRooms = async (req, res) => {
  try {
    const { status } = req.query
    const where = status ? { status } : { status: { in: ['SCHEDULED', 'ACTIVE'] } }

    const rooms = await prisma.auctionRoom.findMany({
      where,
      include: ROOM_INCLUDE_PUBLIC,
      orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }]
    })

    res.json({ success: true, data: rooms })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Lịch sử các phiên đã kết thúc (public, để xem acc đã đấu giá xong giá bao nhiêu)
const getEndedRooms = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query
    const skip = (parseInt(page) - 1) * parseInt(limit)
    const [rooms, total] = await Promise.all([
      prisma.auctionRoom.findMany({
        where: { status: 'ENDED' },
        include: {
          ...ROOM_INCLUDE_PUBLIC,
          winner: { select: { username: true, displayName: true, avatar: true } }
        },
        orderBy: { updatedAt: 'desc' },
        skip, take: parseInt(limit)
      }),
      prisma.auctionRoom.count({ where: { status: 'ENDED' } })
    ])
    res.json({ success: true, data: rooms, pagination: { page: parseInt(page), total, pages: Math.ceil(total / limit) } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const getRoomDetail = async (req, res) => {
  try {
    const { id } = req.params
    const room = await prisma.auctionRoom.findUnique({
      where: { id },
      include: {
        ...ROOM_INCLUDE_PUBLIC,
        winner: { select: { username: true, displayName: true, avatar: true } },
        bids: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: { user: { select: { username: true, displayName: true, avatar: true } } }
        }
      }
    })
    if (!room) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng đấu giá' })

    let myBid = null
    if (req.user?.id) {
      myBid = await prisma.auctionBid.findFirst({
        where: { roomId: id, userId: req.user.id, isRefunded: false },
        orderBy: { createdAt: 'desc' }
      })
    }

    res.json({ success: true, data: { ...room, myActiveBid: myBid } })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// ── Đặt giá (bid) ───────────────────────────────────────────────────────
// Quy tắc: hold tiền ngay trong ví (trừ balance), hoàn lại nếu bị vượt giá.
// KHÔNG tự gia hạn thời gian khi có bid sát giờ chót — hết giờ là hết.
const placeBid = async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.id
    const amount = parseFloat(req.body.amount)

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Số tiền đặt giá không hợp lệ' })
    }

    const result = await prisma.$transaction(async (tx) => {
      const room = await tx.auctionRoom.findUnique({ where: { id } })
      if (!room) throw Object.assign(new Error('Không tìm thấy phòng đấu giá'), { code: 404 })
      if (room.status !== 'ACTIVE') throw Object.assign(new Error('Phòng đấu giá chưa mở hoặc đã kết thúc'), { code: 400 })
      if (!room.endsAt || new Date() >= new Date(room.endsAt)) throw Object.assign(new Error('Đã hết giờ đấu giá'), { code: 400 })

      const basePrice = room.currentPrice ? parseFloat(room.currentPrice) : parseFloat(room.startingPrice)
      const minBid = room.currentPrice ? basePrice + parseFloat(room.bidStep) : parseFloat(room.startingPrice)

      if (amount < minBid) {
        throw Object.assign(new Error(`Giá đặt phải tối thiểu ${minBid.toLocaleString('vi-VN')}đ`), { code: 400 })
      }

      if (room.currentBidderId === userId) {
        throw Object.assign(new Error('Bạn đang là người giữ giá cao nhất'), { code: 400 })
      }

      const user = await tx.user.findUnique({ where: { id: userId } })
      if (parseFloat(user.balance) < amount) {
        throw Object.assign(new Error('Số dư không đủ để đặt giá'), { code: 400 })
      }

      // Hoàn tiền người giữ giá cao nhất trước đó (nếu có)
      if (room.currentBidderId) {
        const prevBid = await tx.auctionBid.findFirst({
          where: { roomId: id, userId: room.currentBidderId, isRefunded: false },
          orderBy: { createdAt: 'desc' }
        })

        if (prevBid) {
          const prevUser = await tx.user.update({
            where: { id: room.currentBidderId },
            data: { balance: { increment: prevBid.amount } }
          })
          await tx.auctionBid.update({ where: { id: prevBid.id }, data: { isRefunded: true } })
          await tx.transaction.create({
            data: {
              userId: room.currentBidderId,
              type: 'AUCTION_REFUND',
              amount: parseFloat(prevBid.amount),
              balanceBefore: parseFloat(prevUser.balance) - parseFloat(prevBid.amount),
              balanceAfter: parseFloat(prevUser.balance),
              description: `Hoàn tiền đặt giá — bị vượt giá tại "${room.title}"`,
              referenceId: room.id
            }
          })
          emitToUser(room.currentBidderId, 'balance:update', {})
          emitToUser(room.currentBidderId, 'auction:outbid', { roomId: room.id, title: room.title })
        }
      }

      // Trừ tiền (hold) người đặt giá mới
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: amount } }
      })

      const bid = await tx.auctionBid.create({
        data: { roomId: id, userId, amount }
      })

      await tx.transaction.create({
        data: {
          userId,
          type: 'AUCTION_HOLD',
          amount: -amount,
          balanceBefore: parseFloat(updatedUser.balance) + amount,
          balanceAfter: parseFloat(updatedUser.balance),
          description: `Đặt giá tại "${room.title}"`,
          referenceId: room.id
        }
      })

      const updatedRoom = await tx.auctionRoom.update({
        where: { id },
        data: {
          currentPrice: amount,
          currentBidderId: userId,
          totalBids: { increment: 1 }
        }
      })

      return { bid, room: updatedRoom }
    })

    emitToUser(userId, 'balance:update', {})

    const io = getIO()
    io.to(`auction:${id}`).emit('auction:bid', {
      roomId: id,
      amount: result.bid.amount,
      bidder: { username: req.user.username, displayName: req.user.displayName, avatar: req.user.avatar },
      totalBids: result.room.totalBids,
      createdAt: result.bid.createdAt
    })

    res.status(201).json({ success: true, data: result.bid })
  } catch (e) {
    res.status(e.code || 500).json({ success: false, message: e.message })
  }
}

// ── Admin ─────────────────────────────────────────────────────────────
const adminGetRooms = async (req, res) => {
  try {
    const rooms = await prisma.auctionRoom.findMany({
      include: {
        ...ROOM_INCLUDE_PUBLIC,
        winner: { select: { username: true, displayName: true } },
        _count: { select: { bids: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ success: true, data: rooms })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Tạo phòng trước (chỉ có tiêu đề + thời gian dự kiến) — hiện trên thanh chạy ngang chờ tới giờ
const adminCreateRoom = async (req, res) => {
  try {
    const { title, description, scheduledAt } = req.body
    const room = await prisma.auctionRoom.create({
      data: {
        title,
        description,
        scheduledAt: new Date(scheduledAt),
        startingPrice: 0,
        thumbnailUrl: req.file?.path || null,
        thumbnailPublicId: req.file?.filename || null,
      }
    })
    emitToAll('auction:room_created', { id: room.id, title: room.title, scheduledAt: room.scheduledAt })
    res.status(201).json({ success: true, data: room })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminUpdateRoom = async (req, res) => {
  try {
    const data = {}
    if (req.body.title !== undefined) data.title = req.body.title
    if (req.body.description !== undefined) data.description = req.body.description
    if (req.body.scheduledAt !== undefined) data.scheduledAt = new Date(req.body.scheduledAt)
    if (req.file?.path) { data.thumbnailUrl = req.file.path; data.thumbnailPublicId = req.file.filename }

    const room = await prisma.auctionRoom.update({ where: { id: req.params.id }, data })
    res.json({ success: true, data: room })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

// Admin "up acc" và bấm bắt đầu — gắn acc thật + set giá khởi điểm + thời lượng, mở cho bid
const adminStartRoom = async (req, res) => {
  try {
    const { id } = req.params
    const { gameAccountId, startingPrice, bidStep, durationMinutes } = req.body

    const room = await prisma.auctionRoom.findUnique({ where: { id } })
    if (!room) return res.status(404).json({ success: false, message: 'Không tìm thấy phòng' })
    if (room.status !== 'SCHEDULED') return res.status(400).json({ success: false, message: 'Phòng đã bắt đầu hoặc đã kết thúc' })

    const gameAccount = await prisma.gameAccount.findUnique({ where: { id: gameAccountId } })
    if (!gameAccount) return res.status(404).json({ success: false, message: 'Không tìm thấy acc' })
    if (gameAccount.status !== 'AVAILABLE') return res.status(400).json({ success: false, message: 'Acc này không khả dụng (đã bán/đang giữ chỗ)' })

    const now = new Date()
    const endsAt = new Date(now.getTime() + parseInt(durationMinutes) * 60 * 1000)

    const [updatedRoom] = await prisma.$transaction([
      prisma.auctionRoom.update({
        where: { id },
        data: {
          gameAccountId,
          startingPrice: parseFloat(startingPrice),
          bidStep: parseFloat(bidStep || 10000),
          startedAt: now,
          endsAt,
          status: 'ACTIVE'
        }
      }),
      prisma.gameAccount.update({ where: { id: gameAccountId }, data: { status: 'RESERVED' } })
    ])

    emitToAll('auction:room_started', { id: updatedRoom.id, title: updatedRoom.title, endsAt: updatedRoom.endsAt })
    res.json({ success: true, data: updatedRoom })
  } catch (e) { res.status(500).json({ success: false, message: e.message }) }
}

const adminCancelRoom = async (req, res) => {
  try {
    const { id } = req.params
    const { reason } = req.body

    await prisma.$transaction(async (tx) => {
      const room = await tx.auctionRoom.findUnique({ where: { id } })
      if (!room) throw Object.assign(new Error('Không tìm thấy phòng'), { code: 404 })
      if (room.status === 'ENDED' || room.status === 'CANCELLED') {
        throw Object.assign(new Error('Phòng đã kết thúc/đã huỷ trước đó'), { code: 400 })
      }

      // Hoàn tiền người đang giữ giá cao nhất (nếu có)
      if (room.currentBidderId) {
        const bid = await tx.auctionBid.findFirst({
          where: { roomId: id, userId: room.currentBidderId, isRefunded: false },
          orderBy: { createdAt: 'desc' }
        })
        if (bid) {
          const u = await tx.user.update({ where: { id: room.currentBidderId }, data: { balance: { increment: bid.amount } } })
          await tx.auctionBid.update({ where: { id: bid.id }, data: { isRefunded: true } })
          await tx.transaction.create({
            data: {
              userId: room.currentBidderId,
              type: 'AUCTION_REFUND',
              amount: parseFloat(bid.amount),
              balanceBefore: parseFloat(u.balance) - parseFloat(bid.amount),
              balanceAfter: parseFloat(u.balance),
              description: `Hoàn tiền — phòng đấu giá "${room.title}" đã bị huỷ`,
              referenceId: room.id
            }
          })
          emitToUser(room.currentBidderId, 'balance:update', {})
        }
      }

      if (room.gameAccountId) {
        await tx.gameAccount.update({ where: { id: room.gameAccountId }, data: { status: 'AVAILABLE' } })
      }

      await tx.auctionRoom.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason || null } })
    })

    emitToAll('auction:room_cancelled', { id })
    res.json({ success: true, message: 'Đã huỷ phòng đấu giá' })
  } catch (e) {
    res.status(e.code || 500).json({ success: false, message: e.message })
  }
}

// ── Cron: đóng các phòng đã hết giờ, chốt người thắng ──────────────────
// KHÔNG gia hạn thêm — chỉ xử lý những phòng đã qua endsAt tại thời điểm chạy job.
const closeExpiredRooms = async () => {
  try {
    const expiredRooms = await prisma.auctionRoom.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: new Date() } }
    })

    for (const room of expiredRooms) {
      try {
        await prisma.$transaction(async (tx) => {
          if (room.currentBidderId) {
            const winningBid = await tx.auctionBid.findFirst({
              where: { roomId: room.id, userId: room.currentBidderId, isRefunded: false },
              orderBy: { createdAt: 'desc' }
            })

            const gameAccount = await tx.gameAccount.findUnique({
              where: { id: room.gameAccountId },
              include: { images: { orderBy: { sortOrder: 'asc' } } }
            })

            await tx.gameAccount.update({
              where: { id: room.gameAccountId },
              data: { status: 'SOLD', soldAt: new Date(), soldToId: room.currentBidderId }
            })

            await tx.userOwnedAccount.create({
              data: {
                userId: room.currentBidderId,
                accountId: gameAccount.id,
                sourceType: 'AUCTION_WIN',
                sourceId: room.id,
                snapshotData: JSON.stringify({
                  title: gameAccount.title,
                  code: gameAccount.code,
                  rank: gameAccount.rank,
                  server: gameAccount.server,
                  champions: gameAccount.champions,
                  skins: gameAccount.skins,
                  level: gameAccount.level,
                  price: winningBid?.amount || room.currentPrice,
                  thumbnailUrl: gameAccount.thumbnailUrl,
                  images: gameAccount.images?.map(i => ({ url: i.url, sortOrder: i.sortOrder })) || [],
                  gameUsername: gameAccount.gameUsername,
                  gamePassword: gameAccount.gamePassword,
                  gameBindEmail: gameAccount.gameBindEmail,
                  gameBindPhone: gameAccount.gameBindPhone,
                  gameBindFacebook: gameAccount.gameBindFacebook,
                  auctionRoomTitle: room.title,
                })
              }
            })

            if (winningBid) {
              await tx.auctionBid.update({ where: { id: winningBid.id }, data: { isWinning: true } })
            }

            const winnerUser = await tx.user.update({
              where: { id: room.currentBidderId },
              data: { totalSpent: { increment: room.currentPrice } }
            })

            await tx.transaction.create({
              data: {
                userId: room.currentBidderId,
                type: 'AUCTION_WIN',
                amount: 0, // tiền đã trừ (hold) lúc đặt giá, ở đây chỉ ghi nhận đã chốt thắng
                balanceBefore: parseFloat(winnerUser.balance),
                balanceAfter: parseFloat(winnerUser.balance),
                description: `Thắng đấu giá "${room.title}" với giá ${parseFloat(room.currentPrice).toLocaleString('vi-VN')}đ`,
                referenceId: room.id
              }
            })

            await tx.notification.create({
              data: {
                userId: room.currentBidderId,
                type: 'AUCTION',
                title: 'Bạn đã thắng đấu giá!',
                message: `Chúc mừng! Bạn đã thắng phiên đấu giá "${room.title}" với giá ${parseFloat(room.currentPrice).toLocaleString('vi-VN')}đ. Acc đã được thêm vào "Acc đã sở hữu".`
              }
            })

            await tx.auctionRoom.update({
              where: { id: room.id },
              data: {
                status: 'ENDED',
                winnerId: room.currentBidderId,
                winningBidId: winningBid?.id || null
              }
            })

            emitToUser(room.currentBidderId, 'balance:update', {})
            emitToUser(room.currentBidderId, 'notification', { type: 'AUCTION', title: 'Bạn đã thắng đấu giá!', message: room.title })
            checkAndGrantAchievements(room.currentBidderId)
          } else {
            // Không ai bid — trả acc về trạng thái AVAILABLE, đóng phòng
            if (room.gameAccountId) {
              await tx.gameAccount.update({ where: { id: room.gameAccountId }, data: { status: 'AVAILABLE' } })
            }
            await tx.auctionRoom.update({ where: { id: room.id }, data: { status: 'ENDED' } })
          }
        })

        const io = getIO()
        io.to(`auction:${room.id}`).emit('auction:ended', { roomId: room.id, winnerId: room.currentBidderId })
        emitToAll('auction:ended', { roomId: room.id })
      } catch (err) {
        console.error(`[closeExpiredRooms] room ${room.id} error:`, err.message)
      }
    }
  } catch (e) {
    console.error('[closeExpiredRooms] error:', e.message)
  }
}

module.exports = {
  getRooms, getEndedRooms, getRoomDetail, placeBid,
  adminGetRooms, adminCreateRoom, adminUpdateRoom, adminStartRoom, adminCancelRoom,
  closeExpiredRooms
}
