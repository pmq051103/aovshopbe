/**
 * chatbot.controller.js  (RAG Edition)
 * ─────────────────────────────────────────────────────────────────────────
 * Luồng xử lý mỗi tin nhắn:
 *
 *  1. User gửi câu hỏi
 *  2. Tìm kiếm ngữ nghĩa trên Pinecone (RAG context)
 *  3. Gắn context vào system prompt
 *  4. Gemini 2.5-flash-lite phân tích intent + trả lời dựa trên context
 *  5. Lấy dữ liệu động từ MySQL nếu cần (acc, túi mù, vòng quay, v.v.)
 *  6. Trả về JSON chuẩn cho frontend
 *
 * Nguyên tắc RAG:
 *  - Chỉ đưa kiến thức tĩnh (FAQ/chính sách/hướng dẫn) vào Pinecone
 *  - Dữ liệu động (acc, đơn hàng, số dư, túi mù...) lấy trực tiếp từ MySQL
 *  - Nếu không tìm thấy context liên quan → Gemini vẫn dùng system prompt gốc
 *  - Gemini KHÔNG được bịa nếu không có thông tin trong context
 * ─────────────────────────────────────────────────────────────────────────
 */

const prisma = require('../config/prisma')
const logger = require('../config/logger')
const { searchSimilar } = require('../services/pinecone.service')

const PHONE_TELCOS = ['VIETTEL', 'VINAPHONE', 'MOBIFONE', 'VIETNAMOBILE', 'GMOBILE', 'REDDI']

/* ─────────────────────────────────────────────────────────
   SYSTEM PROMPT BASE (không thay đổi)
   Context RAG sẽ được inject vào trước mỗi request
───────────────────────────────────────────────────────── */
const SYSTEM_PROMPT_BASE = `
Bạn là "Quang" – trợ lý AI thân thiện, vui vẻ của LQ Shop, chuyên bán acc Liên Quân Mobile.
Bạn nói chuyện bằng tiếng Việt, xưng "mình", gọi khách là "bạn".
Phong cách: trẻ trung, nhiệt tình, hay dùng emoji phù hợp.

━━━ PHẠM VI HỖ TRỢ ━━━
Bạn CHỈ hỗ trợ các nội dung liên quan đến:
- Chào hỏi, cảm ơn, xã giao cơ bản
- Shop LQ Shop
- Tư vấn, tìm kiếm acc Liên Quân Mobile
- Giá acc, rank, skin, tướng, độ hot, acc nổi bật
- Thông tin liên kết acc: Mail, SĐT, Facebook sống, Facebook RIP, không liên kết Facebook
- Cách mua acc, thanh toán, nạp tiền
- Hỗ trợ tài khoản, đơn hàng, vấn đề khi mua acc
- Hỗ trợ nạp tiền: hướng dẫn nạp, kiểm tra lịch sử nạp, trạng thái giao dịch, xử lý sự cố
- Hỗ trợ mua mã thẻ điện thoại / thẻ game: Viettel, Vinaphone, Mobifone, Garena, Gate...
- Tư vấn túi mù (mystery box)
- Tư vấn vòng quay may mắn (lucky wheel)
- Đấu giá acc: phòng đang mở/sắp diễn ra, giá hiện tại, cách tham gia
- Chợ trao đổi: tin đăng bán acc P2P giữa các user
- Các chính sách, quy định, hướng dẫn của shop

Nếu người dùng hỏi ngoài phạm vi trên thì PHẢI trả đúng dạng:
{
  "intent": "chat",
  "reply": "Mình hiện chỉ hỗ trợ tư vấn acc, túi mù, vòng quay, nạp tiền và mua thẻ tại shop 🎮 Các vấn đề khác bạn vui lòng liên hệ bộ phận hỗ trợ <a href='/tickets' class='text-neon-pink underline font-semibold'>tại đây</a> 😊",
  "filters": null
}

━━━ NHIỆM VỤ ━━━
1. Chào hỏi, cảm ơn, xã giao cơ bản → intent = "chat", filters = null
2. Hỏi về shop, giá cả chung, cách mua, thanh toán, nạp tiền → intent = "chat", filters = null
3. Yêu cầu tìm/xem acc game Liên Quân → intent = "search_acc", tạo filters phù hợp
4. Hỏi về túi mù / mystery box → intent = "search_mystery_box", tạo filters phù hợp
5. Hỏi về vòng quay may mắn → intent = "view_wheel"
6. Hỏi về nạp tiền / số dư / lịch sử nạp / giao dịch thất bại → intent = "deposit_support"
7. Hỏi về mua thẻ điện thoại / thẻ game / mã thẻ / card → intent = "card_shop_support"
8. Hỏi về đấu giá / phòng đấu giá / acc đang đấu giá → intent = "view_auctions"
9. Hỏi về chợ trao đổi / tin đăng bán acc P2P / acc ký gửi → intent = "search_marketplace"
10. Câu hỏi ngoài lề → redirect sang bộ phận hỗ trợ như mẫu ở trên

━━━ OUTPUT BẮT BUỘC ━━━
Chỉ trả về JSON thuần, không markdown, không giải thích ngoài JSON.

Khi KHÔNG tìm kiếm gì:
{
  "intent": "chat",
  "reply": "câu trả lời thân thiện",
  "filters": null
}

Khi tìm acc:
{
  "intent": "search_acc",
  "reply": "câu trả lời thân thiện trước khi hiện kết quả",
  "filters": {
    "rank": null,
    "minPrice": null,
    "maxPrice": null,
    "minSkins": null,
    "maxSkins": null,
    "minChampions": null,
    "maxChampions": null,
    "skinName": null,
    "sort": null,
    "featured": false,
    "hasEmail": false,
    "hasPhone": false,
    "blankInfo": false,
    "gameBindFacebook": null,
    "limit": 5
  }
}

Khi hỏi túi mù:
{
  "intent": "search_mystery_box",
  "reply": "câu trả lời thân thiện",
  "filters": {
    "maxPrice": null,
    "minPrice": null,
    "rarity": null,
    "sort": null,
    "limit": 5
  }
}

Khi hỏi vòng quay:
{
  "intent": "view_wheel",
  "reply": "câu trả lời thân thiện giới thiệu vòng quay",
  "filters": null
}

Khi hỏi nạp tiền:
{
  "intent": "deposit_support",
  "reply": "câu trả lời thân thiện + hướng dẫn cụ thể",
  "depositAction": "guide",
  "filters": null
}

Khi hỏi mua thẻ điện thoại / thẻ game:
{
  "intent": "card_shop_support",
  "reply": "câu trả lời thân thiện",
  "cardAction": "guide",
  "filters": {
    "telco": null,
    "type": null,
    "minPrice": null,
    "maxPrice": null,
    "limit": 8
  }
}

depositAction chỉ được là:
- "guide"
- "history"
- "status"

cardAction chỉ được là:
- "guide"
- "list"

Khi hỏi đấu giá:
{
  "intent": "view_auctions",
  "reply": "câu trả lời thân thiện giới thiệu các phòng đấu giá",
  "filters": {
    "status": null,
    "limit": 8
  }
}

status đấu giá chỉ được là: "SCHEDULED" | "ACTIVE" | "ENDED" | null (null = lấy cả sắp diễn ra và đang mở)

Khi hỏi chợ trao đổi:
{
  "intent": "search_marketplace",
  "reply": "câu trả lời thân thiện giới thiệu tin đăng phù hợp",
  "filters": {
    "minPrice": null,
    "maxPrice": null,
    "hasFullInfo": null,
    "keyword": null,
    "limit": 8
  }
}

━━━ QUY TẮC GIÁ ━━━
- "200k" / "200 nghìn" / "hai trăm k" = 200000
- "600k" / "sáu trăm k" = 600000
- "1 triệu" / "1tr" / "một triệu" = 1000000
- Mọi giá trị có đuôi "k" phải × 1000
- "dưới X" / "không quá X" → maxPrice = X
- "trên X" / "từ X" / "ít nhất X" → minPrice = X
- "từ X đến Y" / "khoảng X-Y" → minPrice=X, maxPrice=Y
- "mua thẻ 50k" / "thẻ 50k" → minPrice = 50000 và maxPrice = 50000
- "rẻ" / "giá rẻ" → sort = "price_asc"
- "đắt" / "xịn" → sort = "price_desc"

━━━ RANK ━━━
- "đồng" → "Đồng"
- "bạc" → "Bạc"
- "vàng" → "Vàng"
- "bạch kim" / "platinum" → "Bạch Kim"
- "kim cương" / "kc" / "diamond" → "Kim Cương"
- "cao thủ" / "master" / "ct" → "Cao Thủ"
- "chiến tướng" / "grandmaster" → "Chiến Tướng"
- "thách đấu" / "challenger" / "td" → "Thách Đấu"

━━━ SKIN / TƯỚNG ━━━
- "nhiều skin" → sort = "skins_desc"
- "ít nhất X skin" / "X skin trở lên" → minSkins = X
- "nhiều tướng" → sort = "champions_desc"
- "có skin [tên]" / "skin [tên]" → skinName = "[tên]"

━━━ THÔNG TIN LIÊN KẾT ACC ━━━
- "có mail" / "có email" / "mail trắng" → hasEmail = true
- "có sđt" / "có số điện thoại" → hasPhone = true
- "trắng thông tin" / "không có gì" / "acc trắng" / "thông tin trắng" → blankInfo = true (đặt hasEmail = false, hasPhone = false)
- "chỉ có sđt" / "chỉ có số điện thoại" / "chỉ sđt" → hasPhone = true, hasEmail = false
- "chỉ có mail" / "chỉ có email" → hasEmail = true, hasPhone = false
- "fb sống" / "facebook sống" / "fb live" → gameBindFacebook = "LIVE"
- "fb rip" / "facebook rip" → gameBindFacebook = "RIP"
- "không liên kết fb" / "không fb" / "chưa liên kết facebook" → gameBindFacebook = "NONE"
- Khi blankInfo = true thì hasEmail và hasPhone phải là false

━━━ TÚI MÙ / VÒNG QUAY ━━━
- "túi mù" / "mystery box" / "hộp mù" / "mở hộp" → search_mystery_box
- "vòng quay" / "lucky wheel" / "quay thưởng" / "quay may mắn" → view_wheel

ĐỘ HIẾM TÚI MÙ:
- "thường" / "phổ thông" → rarity = "COMMON"
- "hiếm" → rarity = "RARE"
- "sử thi" / "epic" → rarity = "EPIC"
- "huyền thoại" / "legendary" → rarity = "LEGENDARY"

━━━ MUA THẺ ĐIỆN THOẠI / THẺ GAME ━━━
- "mua thẻ" / "mua card" / "bán thẻ" / "mã thẻ" / "softcard" → card_shop_support
- "mua thẻ điện thoại" / "thẻ điện thoại" → type = "PHONE", cardAction = "list"
- "mua thẻ game" / "thẻ game" → type = "GAME", cardAction = "list"
- "shop có bán thẻ không" → cardAction = "list"
- "hướng dẫn mua thẻ" → cardAction = "guide"
- "viettel" → telco = "VIETTEL", type = "PHONE"
- "vinaphone" / "vina" → telco = "VINAPHONE", type = "PHONE"
- "mobifone" / "mobi" → telco = "MOBIFONE", type = "PHONE"
- "vietnamobile" → telco = "VIETNAMOBILE", type = "PHONE"
- "garena" → telco = "GARENA", type = "GAME"
- "gate" → telco = "GATE", type = "GAME"
- "zing" → telco = "ZING", type = "GAME"
- "vcoin" → telco = "VCOIN", type = "GAME"

━━━ NẠP TIỀN ━━━
- Shop hỗ trợ:
  1. Nạp bằng QR Pay / chuyển khoản ngân hàng tự động
  2. Nạp bằng thẻ cào điện thoại / thẻ game nếu người dùng không có ngân hàng
- "nạp tiền" / "nạp xu" / "top up" / "thêm tiền" → deposit_support
- "cách nạp" / "hướng dẫn nạp" → depositAction = "guide"
- "không có atm" → depositAction = "guide" và gợi ý nạp bằng thẻ cào
- "lịch sử nạp" / "đã nạp" / "giao dịch" → depositAction = "history"
- "nạp chưa vào" / "nạp bị lỗi" / "không thấy tiền" → depositAction = "status"

━━━ XÃ GIAO HỢP LỆ ━━━
- "xin chào" / "hello" / "hi" → chào lại vui vẻ, giới thiệu bản thân
- "cảm ơn" → "Không có gì! Mình luôn sẵn sàng giúp bạn 😊"
- "shop có gì" / "bán gì" → giới thiệu shop bán acc Liên Quân, túi mù, vòng quay và mã thẻ
- "mua như thế nào" / "cách mua" → hướng dẫn chọn acc → bấm mua → thanh toán

━━━ ĐẤU GIÁ ━━━
- "đấu giá" / "phòng đấu giá" / "acc đang đấu giá" / "đang bid" / "sắp đấu giá" → view_auctions
- "sắp diễn ra" / "chuẩn bị đấu giá" → status = "SCHEDULED"
- "đang diễn ra" / "đang mở" / "đang nhận bid" → status = "ACTIVE"
- "đã kết thúc" / "ai thắng" / "kết quả đấu giá" → status = "ENDED"
- Không nói rõ trạng thái → status = null

━━━ CHỢ TRAO ĐỔI ━━━
- "chợ trao đổi" / "chợ" / "tin đăng bán acc" / "acc người khác bán" / "acc ký gửi"
  → intent = "search_marketplace".

- "có bind info" / "có liên kết" / "acc full thông tin"
  → hasFullInfo = true.

- "acc trắng" trong chợ trao đổi
  → hasFullInfo = false.

- Domain chính thức của shop là https://aovshop.id.vn.
- Trang xem danh sách Chợ trao đổi: /cho-trao-doi.
- Trang đăng bán và quản lý tin của user: /cho-trao-doi/cua-toi.
- Trang chi tiết tin đăng: /cho-trao-doi/{listingId}.

- TUYỆT ĐỐI KHÔNG dùng:
  /marketplace
  https://aovshop.vn
  https://aovshop.vn/marketplace

- Khi user hỏi cách đăng bán acc, up acc bán hoặc quản lý tin đăng, dùng:
  <a href="/cho-trao-doi/cua-toi" class="text-neon-pink underline font-semibold">Đăng bán acc</a>

- Khi user muốn xem các acc đang được bán trên chợ, dùng:
  <a href="/cho-trao-doi" class="text-neon-pink underline font-semibold">Chợ trao đổi</a>

- Ưu tiên URL tương đối bắt đầu bằng dấu /, không tự tạo domain khác.

━━━ LƯU Ý ━━━
- filters phải null nếu không tìm acc / túi mù / mua thẻ
- limit mặc định 5, tối đa 10
- sort hợp lệ: newest | price_asc | price_desc | popular | skins_desc | champions_desc
- gameBindFacebook chỉ được: LIVE | RIP | NONE | null
- type mua thẻ chỉ được: PHONE | GAME | null
- KHÔNG tự thêm filter ngoài yêu cầu rõ ràng
`

/**
 * Build system prompt với RAG context được inject vào
 * @param {Array<{title:string, type:string, content:string, score:number}>} ragContext
 * @returns {string}
 */
function buildSystemPromptWithRAG(ragContext) {
  if (!ragContext || ragContext.length === 0) {
    return SYSTEM_PROMPT_BASE
  }

  const typeLabel = { FAQ: 'Câu hỏi thường gặp', POLICY: 'Chính sách', GUIDE: 'Hướng dẫn', TERM: 'Điều khoản' }

  const contextBlock = ragContext
    .map((item, idx) => {
      const label = typeLabel[item.type] || item.type
      return `[${idx + 1}] ${label}: ${item.title}\n${item.content}`
    })
    .join('\n\n---\n\n')

  return `${SYSTEM_PROMPT_BASE}

━━━ KIẾN THỨC CỦA SHOP (dựa trên câu hỏi hiện tại) ━━━
Dưới đây là các thông tin chính sách / hướng dẫn / FAQ của shop liên quan đến câu hỏi này.
Hãy ưu tiên trả lời DỰA TRÊN các thông tin này. Nếu thông tin không đủ để trả lời,
hãy nói rõ và hướng dẫn user liên hệ hỗ trợ. KHÔNG được bịa thêm thông tin.

${contextBlock}

━━━ KẾT THÚC KIẾN THỨC ━━━
`
}

/* ─────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────── */
function normalizeMessages(messages = []) {
  return messages
    .filter(m => m && m.content)
    .map(m => ({
      role : m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }))
}

function cleanJson(raw = '') {
  return raw.replace(/```json/gi, '').replace(/```/g, '').trim()
}

function normalizeChatLinks(text = '') {
  return String(text)
    // Domain sai + route marketplace chi tiết
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.vn\/marketplace\/([^"' )<]+)/gi,
      '/cho-trao-doi/$1'
    )

    // Domain sai + route marketplace
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.vn\/marketplace\b/gi,
      '/cho-trao-doi'
    )

    // Domain sai nhưng route đã đúng
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.vn\/cho-trao-doi\/([^"' )<]+)/gi,
      '/cho-trao-doi/$1'
    )
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.vn\/cho-trao-doi\b/gi,
      '/cho-trao-doi'
    )

    // Domain chính xác → đổi thành relative URL
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.id\.vn\/cho-trao-doi\/([^"' )<]+)/gi,
      '/cho-trao-doi/$1'
    )
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.id\.vn\/cho-trao-doi\b/gi,
      '/cho-trao-doi'
    )

    // Route marketplace thuần
    .replace(
      /\/marketplace\/([^"' )<]+)/gi,
      '/cho-trao-doi/$1'
    )
    .replace(
      /\/marketplace\b/gi,
      '/cho-trao-doi'
    )

    // Domain sai còn sót lại
    .replace(
      /https?:\/\/(?:www\.)?aovshop\.vn\b/gi,
      'https://aovshop.id.vn'
    )
}

function safeParseResponse(raw = '') {
  try {
    const parsed = JSON.parse(cleanJson(raw))
    return {
      intent      : parsed.intent       || 'chat',
      reply: normalizeChatLinks(
        parsed.reply || 'Mình đã hiểu yêu cầu của bạn rồi! 😊'
      ),
      filters     : parsed.filters      || null,
      depositAction: parsed.depositAction || null,
      cardAction  : parsed.cardAction   || null,
    }
  } catch {
    return {
      intent      : 'chat',
      reply: normalizeChatLinks(
        raw || 'Xin lỗi, mình chưa hiểu rõ. Bạn nói lại được không? 😅'
      ),
      filters     : null,
      depositAction: null,
      cardAction  : null,
    }
  }
}

function parsePrice(val) {
  if (!val && val !== 0) return null
  const str = String(val).toLowerCase().replace(/\s/g, '')
  if (str.endsWith('tr')) return parseFloat(str) * 1_000_000
  if (str.endsWith('k'))  return parseFloat(str) * 1_000
  const num = parseFloat(str)
  return isNaN(num) ? null : num
}

function getFacebookLabel(status) {
  if (status === 'LIVE') return 'Liên kết sống'
  if (status === 'RIP')  return 'Liên kết RIP'
  return 'Không liên kết'
}

function normalizeCardFilters(filters = {}) {
  const next = { ...(filters || {}) }
  if (next.telco) next.telco = String(next.telco).toUpperCase()
  if (next.type)  next.type  = String(next.type).toUpperCase()
  return next
}

/* ─────────────────────────────────────────────────────────
   DATA FETCHERS (không thay đổi logic, giữ nguyên từ bản cũ)
───────────────────────────────────────────────────────── */
async function fetchAccounts(filters) {
  if (!filters) return []
  try {
    const where = { status: 'AVAILABLE' }
    if (filters.rank) where.rank = filters.rank

    const minPriceVal = parsePrice(filters.minPrice)
    const maxPriceVal = parsePrice(filters.maxPrice)
    if (minPriceVal !== null || maxPriceVal !== null) {
      where.price = {}
      if (minPriceVal !== null) where.price.gte = minPriceVal
      if (maxPriceVal !== null) where.price.lte = maxPriceVal
    }
    if (filters.minSkins || filters.maxSkins) {
      where.skins = {}
      if (filters.minSkins) where.skins.gte = parseInt(filters.minSkins)
      if (filters.maxSkins) where.skins.lte = parseInt(filters.maxSkins)
    }
    if (filters.minChampions || filters.maxChampions) {
      where.champions = {}
      if (filters.minChampions) where.champions.gte = parseInt(filters.minChampions)
      if (filters.maxChampions) where.champions.lte = parseInt(filters.maxChampions)
    }
    if (filters.featured)         where.isFeatured     = true
    if (filters.blankInfo === true) {
  where.AND = [
    {
      OR: [
        { gameBindEmail: null },
        { gameBindEmail: '' },
      ],
    },
    {
      OR: [
        { gameBindPhone: null },
        { gameBindPhone: '' },
      ],
    },
  ]
} else {
      if (filters.hasEmail === true) where.gameBindEmail  = { not: null }
      if (filters.hasPhone === true) where.gameBindPhone  = { not: null }
    }
    if (filters.gameBindFacebook) {
      where.gameBindFacebook = String(filters.gameBindFacebook).toUpperCase()
    }
    if (filters.skinName) {
      where.skins_rel = { some: { skinName: { contains: filters.skinName } } }
    }

    const orderByMap = {
      newest       : { createdAt: 'desc' },
      price_asc    : { price: 'asc' },
      price_desc   : { price: 'desc' },
      skins_desc   : { skins: 'desc' },
      champions_desc: { champions: 'desc' },
      popular      : { viewCount: 'desc' },
    }
    const orderBy = (filters.sort && orderByMap[filters.sort]) ? orderByMap[filters.sort] : { createdAt: 'desc' }

    const accounts = await prisma.gameAccount.findMany({
      where,
      orderBy,
      take  : Math.min(filters.limit || 5, 10),
      select: {
        id: true, title: true, rank: true, price: true,
        skins: true, champions: true, thumbnailUrl: true,
        isFeatured: true, gameBindEmail: true, gameBindPhone: true, gameBindFacebook: true,
      },
    })

    return accounts.map(a => ({
      id              : a.id,
      title           : a.title,
      rank            : a.rank,
      price           : Number(a.price),
      skins           : a.skins,
      skin            : a.skins,
      champions       : a.champions,
      thumbnailUrl    : a.thumbnailUrl,
      isFeatured      : a.isFeatured,
      hasBindEmail    : !!a.gameBindEmail,
      hasBindPhone    : !!a.gameBindPhone,
      gameBindFacebook: a.gameBindFacebook || 'NONE',
      facebookLabel   : getFacebookLabel(a.gameBindFacebook),
    }))
  } catch (err) {
    logger.error('[Chatbot] fetchAccounts error:', err.message)
    return []
  }
}

async function fetchMysteryBoxes(filters) {
  if (!filters) return []
  try {
    const where = { isActive: true }
    const minPriceVal = parsePrice(filters.minPrice)
    const maxPriceVal = parsePrice(filters.maxPrice)
    if (minPriceVal !== null || maxPriceVal !== null) {
      where.price = {}
      if (minPriceVal !== null) where.price.gte = minPriceVal
      if (maxPriceVal !== null) where.price.lte = maxPriceVal
    }
    if (filters.rarity) where.rarity = filters.rarity

    const orderByMap = {
      newest    : { createdAt: 'desc' },
      price_asc : { price: 'asc' },
      price_desc: { price: 'desc' },
      popular   : { sortOrder: 'asc' },
    }
    const orderBy = (filters.sort && orderByMap[filters.sort]) ? orderByMap[filters.sort] : { sortOrder: 'asc' }

    const categories = await prisma.mysteryBoxCategory.findMany({
      where,
      orderBy,
      take   : Math.min(filters.limit || 5, 10),
      include: { _count: { select: { accounts: { where: { isSold: false } } } } },
    })

    return categories.map(c => ({
      id            : c.id,
      name          : c.name,
      slug          : c.slug,
      price         : Number(c.price),
      rarity        : c.rarity,
      thumbnail     : c.thumbnail,
      availableCount: c._count.accounts,
    }))
  } catch (err) {
    logger.error('[Chatbot] fetchMysteryBoxes error:', err.message)
    return []
  }
}

async function fetchWheel() {
  try {
    return await prisma.luckyWheel.findFirst({
      where  : { isActive: true },
      include: {
        rewards: {
          where  : { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select : { id: true, name: true, value: true, type: true, probability: true, color: true },
        },
      },
    })
  } catch (err) {
    logger.error('[Chatbot] fetchWheel error:', err.message)
    return null
  }
}

async function fetchDepositInfo(action, userId) {
  try {
    if (action === 'history' || action === 'status') {
      const where = { userId }
      if (action === 'status') where.status = 'PENDING'
      const deposits = await prisma.deposit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take   : 5,
        select : { id: true, amount: true, status: true, createdAt: true, expiredAt: true, bankCode: true },
      })
      return deposits.map(d => ({
        id       : d.id,
        amount   : Number(d.amount),
        status   : d.status,
        createdAt: d.createdAt,
        expiredAt: d.expiredAt,
        method   : d.bankCode || 'PAYOS',
      }))
    }
    return []
  } catch (err) {
    logger.error('[Chatbot] fetchDepositInfo error:', err.message)
    return []
  }
}

async function fetchBuyCards(filters = {}) {
  try {
    const f = normalizeCardFilters(filters)
    const where = { buyEnabled: true }
    if (f.telco)          { where.telco = f.telco }
    else if (f.type === 'PHONE') { where.telco = { in: PHONE_TELCOS } }
    else if (f.type === 'GAME')  { where.telco = { notIn: PHONE_TELCOS } }

    const minPriceVal = parsePrice(f.minPrice)
    const maxPriceVal = parsePrice(f.maxPrice)
    if (minPriceVal !== null || maxPriceVal !== null) {
      where.denomination = {}
      if (minPriceVal !== null) where.denomination.gte = minPriceVal
      if (maxPriceVal !== null) where.denomination.lte = maxPriceVal
    }

    const cards = await prisma.cardConfig.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { telco: 'asc' }, { denomination: 'asc' }],
      take   : Math.min(f.limit || 8, 12),
      select : { id: true, telco: true, telcoLabel: true, denomination: true, buyEnabled: true, buyDiscount: true, thumbnailUrl: true },
    })

    return cards.map(c => {
      const denomination = Number(c.denomination)
      const buyDiscount  = Number(c.buyDiscount || 0)
      const price        = Math.round(denomination * (1 - buyDiscount / 100))
      return {
        id         : c.id,
        telco      : c.telco,
        telcoLabel : c.telcoLabel || c.telco,
        type       : PHONE_TELCOS.includes(c.telco) ? 'PHONE' : 'GAME',
        denomination,
        buyDiscount,
        price,
        thumbnailUrl: c.thumbnailUrl,
        buyUrl      : '/card-shop',
      }
    })
  } catch (err) {
    logger.error('[Chatbot] fetchBuyCards error:', err.message)
    return []
  }
}

async function fetchAuctions(filters = {}) {
  try {
    const status = filters.status ? String(filters.status).trim().toUpperCase() : null
    const where = status ? { status } : { status: { in: ['SCHEDULED', 'ACTIVE'] } }

    const rooms = await prisma.auctionRoom.findMany({
      where,
      orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }],
      take: Math.min(filters.limit || 8, 10),
      include: {
        gameAccount: {
          select: { code: true, title: true, rank: true, skins: true, champions: true, thumbnailUrl: true },
        },
      },
    })

    return rooms.map(r => ({
      id: r.id,
      title: r.title,
      status: r.status,
      thumbnailUrl: r.thumbnailUrl || r.gameAccount?.thumbnailUrl || null,
      scheduledAt: r.scheduledAt,
      endsAt: r.endsAt,
      startingPrice: Number(r.startingPrice),
      currentPrice: r.currentPrice != null ? Number(r.currentPrice) : Number(r.startingPrice),
      bidStep: Number(r.bidStep),
      totalBids: r.totalBids,
      accountRank: r.gameAccount?.rank || null,
    }))
  } catch (err) {
    logger.error('[Chatbot] fetchAuctions error:', err.message)
    return []
  }
}

async function fetchMarketplace(filters = {}) {
  try {
    const where = { status: 'APPROVED' }

    const minPriceVal = parsePrice(filters.minPrice)
    const maxPriceVal = parsePrice(filters.maxPrice)
    if (minPriceVal !== null || maxPriceVal !== null) {
      where.price = {}
      if (minPriceVal !== null) where.price.gte = minPriceVal
      if (maxPriceVal !== null) where.price.lte = maxPriceVal
    }
    if (filters.hasFullInfo === true) where.hasFullInfo = true
    if (filters.hasFullInfo === false) where.hasFullInfo = false
    if (filters.keyword) where.title = { contains: filters.keyword }

    const listings = await prisma.marketplaceListing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit || 8, 10),
      include: { seller: { select: { username: true, displayName: true } } },
    })

    return listings.map(l => ({
      id: l.id,
      title: l.title,
      price: Number(l.price),
      hasFullInfo: l.hasFullInfo,
      seller: l.seller.displayName || l.seller.username,
      createdAt: l.createdAt,
    }))
  } catch (err) {
    logger.error('[Chatbot] fetchMarketplace error:', err.message)
    return []
  }
}

/* ─────────────────────────────────────────────────────────
   CONTROLLER CHÍNH
───────────────────────────────────────────────────────── */
function buildFallbackFiltersFromText(text = '') {
  const q = String(text).toLowerCase()

  const filters = {
    rank: null,
    minPrice: null,
    maxPrice: null,
    minSkins: null,
    maxSkins: null,
    minChampions: null,
    maxChampions: null,
    skinName: null,
    sort: null,
    featured: false,
    hasEmail: false,
    hasPhone: false,
    blankInfo: false,
    gameBindFacebook: null,
    limit: 5,
  }

  if (
    q.includes('acc trắng') ||
    q.includes('trắng thông tin') ||
    q.includes('thông tin trắng') ||
    q.includes('không có gì')
  ) {
    filters.blankInfo = true
    filters.hasEmail = false
    filters.hasPhone = false
  }

  // Chỉ khi user nói rõ không FB thì mới lọc Facebook
  if (
    q.includes('không liên kết fb') ||
    q.includes('không fb') ||
    q.includes('chưa liên kết facebook') ||
    q.includes('không liên kết facebook')
  ) {
    filters.gameBindFacebook = 'NONE'
  }

  if (q.includes('chỉ có sđt') || q.includes('chỉ sđt') || q.includes('chỉ có số điện thoại')) {
    filters.blankInfo = false
    filters.hasPhone = true
    filters.hasEmail = false
  }

  if (q.includes('chỉ có mail') || q.includes('chỉ có email')) {
    filters.blankInfo = false
    filters.hasEmail = true
    filters.hasPhone = false
  }

  return filters
}
const chat = async (req, res) => {
  try {
    const { messages, history = [] } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'messages là bắt buộc' })
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY
    const GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, message: 'Chưa cấu hình GEMINI_API_KEY' })
    }

    // ── Lấy câu hỏi cuối cùng của user để search RAG
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    const userQuery   = lastUserMsg?.content || ''

    // ── RAG: Tìm kiếm ngữ nghĩa trên Pinecone
    let ragContext = []
    if (userQuery && process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
      try {
        ragContext = await searchSimilar(userQuery, 4, 0.65)
        if (ragContext.length > 0) {
          logger.info(`[Chatbot] RAG tìm thấy ${ragContext.length} context(s) cho: "${userQuery.slice(0, 60)}"`)
        }
      } catch (ragErr) {
        // RAG lỗi không block chatbot — fallback về Gemini thuần
        logger.warn(`[Chatbot] RAG search failed, fallback: ${ragErr.message}`)
      }
    }

    // ── Build system prompt với RAG context được inject
    const systemPrompt = buildSystemPromptWithRAG(ragContext)

    // ── Gọi Gemini
    const allMessages = [...history, ...messages]
    const contents    = normalizeMessages(allMessages)

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_KEY}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          generationConfig  : { temperature: 0.3, maxOutputTokens: 1400 },
          contents,
        }),
      }
    )

    const geminiData = await geminiRes.json()

    if (!geminiRes.ok) {
  logger.error(`[Chatbot] Gemini API error: ${JSON.stringify(geminiData, null, 2)}`)
  logger.error(`[Chatbot] Gemini status: ${geminiRes.status} ${geminiRes.statusText}`)  

  const fallbackFilters = buildFallbackFiltersFromText(userQuery)
  const accounts = await fetchAccounts(fallbackFilters)

  return res.json({
    success: true,
    data: {
      intent: 'search_acc',
     reply: accounts.length > 0
    ? 'Mình tìm được vài acc phù hợp với yêu cầu của bạn nè 😊'
    : 'Mình chưa tìm thấy acc nào phù hợp với yêu cầu này 😥 Bạn thử đổi tiêu chí tìm kiếm xem sao nhé!',
      filters: fallbackFilters,
      depositAction: null,
      cardAction: null,
      accounts,
      mysteryBoxes: [],
      wheel: null,
      depositInfo: [],
      buyCards: [],
      auctions: [],
      marketplaceListings: [],
      _geminiFallback: true,
      _ragContextCount: ragContext.length,
    },
  })
}

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || ''
    if (!rawText) {
      return res.status(500).json({ success: false, message: 'Gemini không trả về nội dung' })
    }

    const parsed = safeParseResponse(rawText)

    // ── Lấy dữ liệu động từ MySQL theo intent
    let accounts    = []
    let mysteryBoxes = []
    let wheel       = null
    let depositInfo = []
    let buyCards    = []
    let auctions    = []
    let marketplaceListings = []

    if ((parsed.intent === 'search_acc' || parsed.intent === 'search') && parsed.filters) {
      accounts = await fetchAccounts(parsed.filters)
    } else if (parsed.intent === 'search_mystery_box' && parsed.filters) {
      mysteryBoxes = await fetchMysteryBoxes(parsed.filters)
    } else if (parsed.intent === 'view_wheel') {
      wheel = await fetchWheel()
    } else if (parsed.intent === 'deposit_support') {
      if (req.user && (parsed.depositAction === 'history' || parsed.depositAction === 'status')) {
        depositInfo = await fetchDepositInfo(parsed.depositAction, req.user.id)
      }
    } else if (parsed.intent === 'card_shop_support') {
      buyCards = await fetchBuyCards(parsed.filters || {})
    } else if (parsed.intent === 'view_auctions') {
      auctions = await fetchAuctions(parsed.filters || {})
    } else if (parsed.intent === 'search_marketplace') {
      marketplaceListings = await fetchMarketplace(parsed.filters || {})
    }

    return res.json({
      success: true,
      data   : {
        intent      : parsed.intent,
        reply       : parsed.reply,
        filters     : parsed.filters,
        depositAction: parsed.depositAction || null,
        cardAction  : parsed.cardAction    || null,
        accounts,
        mysteryBoxes,
        wheel,
        depositInfo,
        buyCards,
        auctions,
        marketplaceListings,
        // Debug: trả về số RAG context tìm được (có thể bỏ ở production)
        _ragContextCount: ragContext.length,
      },
    })
  } catch (err) {
    logger.error('[Chatbot] Unhandled error:', err)
    return res.status(500).json({ success: false, message: 'Lỗi server chatbot', error: err.message })
  }
}

module.exports = { chat }