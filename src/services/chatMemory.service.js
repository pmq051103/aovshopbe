/**
 * chatMemory.service.js
 * ─────────────────────────────────────────────────────────────────────────
 * In-memory context store cho mỗi chat session.
 *
 * VÌ SAO DÙNG IN-MEMORY thay vì parse DB mỗi turn?
 *  - Stateless parse DB: mỗi request phải đọc metadata từ 20 messages,
 *    JSON.parse từng cái, tái tạo context → chậm + dễ bug khi parse sai.
 *  - In-memory Map: lưu thẳng vào RAM, key = sessionId, access O(1),
 *    không cần parse gì cả. Context luôn chính xác vì được cập nhật
 *    ngay sau mỗi tool call trong cùng request.
 *
 * TRADE-OFF:
 *  - Mất context khi server restart → acceptable vì user chỉ cần hỏi lại.
 *  - Tốn RAM → giới hạn MAX_SESSIONS + TTL 2 giờ auto-cleanup.
 *  - Scale multi-instance → dùng Redis (upgrade sau nếu cần).
 *
 * SCHEMA của mỗi session context:
 * {
 *   sessionId   : string
 *   userId      : string
 *   lastAcc     : object | null   — acc vừa được tìm/nhắc đến
 *   lastOrders  : array  | null   — đơn hàng vừa tra
 *   lastDeposits: array  | null   — nạp tiền vừa tra
 *   lastCards   : array  | null   — thẻ mua vừa tra
 *   lastCardConfigs: array | null — cấu hình thẻ vừa tra
 *   lastMysteryBoxes: array | null
 *   lastWheel   : object | null
 *   lastRankings: array  | null
 *   updatedAt   : number          — timestamp để TTL cleanup
 * }
 * ─────────────────────────────────────────────────────────────────────────
 */

// Map<sessionId, contextObject>
const store = new Map()

const TTL_MS      = 2 * 60 * 60 * 1000  // 2 giờ
const MAX_SESSIONS = 500                  // Giới hạn RAM

/* ── Cleanup sessions cũ hơn TTL ────────────────────── */
function cleanup() {
  const now  = Date.now()
  let deleted = 0
  for (const [sid, ctx] of store.entries()) {
    if (now - ctx.updatedAt > TTL_MS) {
      store.delete(sid)
      deleted++
    }
  }
  if (deleted > 0) {
    console.log(`[ChatMemory] Cleaned ${deleted} expired sessions, remaining: ${store.size}`)
  }
}

// Cleanup mỗi 30 phút
setInterval(cleanup, 30 * 60 * 1000)

/* ── Get hoặc tạo context cho session ───────────────── */
function getContext(sessionId, userId) {
  if (store.has(sessionId)) {
    const ctx = store.get(sessionId)
    ctx.updatedAt = Date.now()
    return ctx
  }

  // Tạo mới
  const ctx = {
    sessionId,
    userId,
    lastAcc         : null,
    lastOrders      : null,
    lastDeposits    : null,
    lastCards       : null,
    lastCardConfigs : null,
    lastMysteryBoxes: null,
    lastWheel       : null,
    lastRankings    : null,
    updatedAt       : Date.now(),
  }

  // Nếu đầy, xóa session cũ nhất
  if (store.size >= MAX_SESSIONS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
    if (oldest) store.delete(oldest[0])
  }

  store.set(sessionId, ctx)
  return ctx
}

/* ── Cập nhật context sau mỗi tool call ─────────────── */
function updateContextFromToolResults(sessionId, userId, toolCallsMade) {
  const ctx = getContext(sessionId, userId)

  for (const tc of toolCallsMade) {
    switch (tc.tool) {
      case 'get_account_detail':
        if (tc.result && !tc.result.error) {
          ctx.lastAcc = tc.result
        }
        break
      case 'search_accounts':
        // Nếu search trả về 1 kết quả duy nhất → lưu luôn làm lastAcc
        if (tc.result?.accounts?.length === 1) {
          ctx.lastAcc = { ...tc.result.accounts[0], type: 'GAME_ACCOUNT' }
        }
        break
      case 'get_order_history':
        if (tc.result?.orders?.length) {
          ctx.lastOrders = tc.result.orders
        }
        break
      case 'get_deposit_history':
        if (tc.result?.deposits?.length) {
          ctx.lastDeposits = tc.result.deposits
        }
        break
      case 'get_card_purchase_history':
        if (tc.result?.purchases?.length) {
          ctx.lastCards = tc.result.purchases
        }
        break
      case 'get_card_config':
        if (tc.result?.configs?.length) {
          ctx.lastCardConfigs = tc.result.configs
        }
        break
      case 'get_mystery_box_info':
        if (tc.result?.mysteryBoxes?.length) {
          ctx.lastMysteryBoxes = tc.result.mysteryBoxes
        }
        break
      case 'get_wheel_info':
        if (tc.result?.wheel) {
          ctx.lastWheel = tc.result.wheel
        }
        break
      case 'get_ranking':
        if (tc.result?.rankings?.length) {
          ctx.lastRankings = tc.result.rankings
        }
        break
    }
  }

  ctx.updatedAt = Date.now()
  return ctx
}

/* ── Xóa context khi user xóa session ───────────────── */
function clearContext(sessionId) {
  store.delete(sessionId)
}

/* ── Stats để debug ─────────────────────────────────── */
function getStats() {
  return { totalSessions: store.size, maxSessions: MAX_SESSIONS }
}

module.exports = { getContext, updateContextFromToolResults, clearContext, getStats }