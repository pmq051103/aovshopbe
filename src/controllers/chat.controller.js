/**
 * chat.controller.js — AI Assistant v3 (In-memory Context + RAG + Tool Calling)
 * ─────────────────────────────────────────────────────────────────────────
 * Thay đổi chính so với v2:
 *  - Dùng chatMemory.service (in-memory Map) thay vì parse DB metadata
 *  - Không còn filter bug (m === recentMsgs.at(-1) luôn false)
 *  - History chỉ lấy messages đã lưu trong DB (không trùng user msg hiện tại)
 *  - Context inject vào user message theo format rõ ràng, Gemini đọc được
 * ─────────────────────────────────────────────────────────────────────────
 */

const prisma = require('../config/prisma')
const logger = require('../config/logger')
const { searchSimilar } = require('../services/pinecone.service')
const { TOOL_DECLARATIONS, executeTool } = require('../services/chatTools.service')
const memStore = require('../services/chatMemory.service')

const GEMINI_MODEL = process.env.GEMINI_CHAT_MODEL
const MAX_TOOL_ITERATIONS = 5
// Số messages lấy làm history (chỉ lấy từ DB, không tính user msg hiện tại)
const HISTORY_LIMIT = 18

/* ══════════════════════════════════════════════════════════
   SYSTEM PROMPT
   ══════════════════════════════════════════════════════════ */
const SYSTEM_PROMPT_BASE = `
Bạn là "Quang" – AI Assistant của LQ Shop, shop bán acc Liên Quân Mobile, túi mù, vòng quay và mã thẻ.
Ngôn ngữ: tiếng Việt. Xưng "mình", gọi user là "bạn". Phong cách trẻ trung, nhiệt tình, dùng emoji phù hợp.

━━━ PHẠM VI HỖ TRỢ ━━━
✅ Tư vấn, tìm kiếm acc Liên Quân (rank/giá/skin/tướng/server/liên kết)
✅ Thông tin shop, chính sách, hướng dẫn mua hàng
✅ Nạp tiền, xem lịch sử giao dịch của chính user
✅ Mua thẻ điện thoại / thẻ game, xem chiết khấu thẻ
✅ Túi mù (mystery box) và vòng quay may mắn
✅ Đơn hàng, lịch sử mua acc của chính user
✅ BXH nạp tiền
✅ Đấu giá acc (phòng đang mở/sắp diễn ra, giá hiện tại, lịch sử bid)
✅ Chợ trao đổi (tin đăng bán acc P2P giữa các user)
✅ Chào hỏi, xã giao cơ bản
❌ KHÔNG hỗ trợ ngoài phạm vi trên.

━━━ ĐẤU GIÁ (AUCTION) ━━━
- "đấu giá", "phòng đấu giá", "acc đang đấu giá", "sắp đấu giá", "đang bid", "ai đang giữ giá", "giá hiện tại bao nhiêu" → BẮT BUỘC gọi search_auctions.
  + Chỉ hỏi "sắp diễn ra" → status = "SCHEDULED".
  + Chỉ hỏi "đang diễn ra"/"đang mở"/"đang bid được" → status = "ACTIVE".
  + Hỏi chung "có phòng đấu giá nào không" → không truyền status (mặc định lấy cả SCHEDULED + ACTIVE).
  + Hỏi "đã kết thúc"/"ai thắng" → status = "ENDED".
- User hỏi chi tiết một phòng cụ thể (theo tên/tiêu đề, hoặc "phòng đó", "phòng vừa nói") → gọi get_auction_detail. Nếu đã có trong CTX.auctions thì dùng luôn, không gọi lại.
- KHÔNG được tự bịa giá hiện tại, người đang giữ giá, hay thời gian kết thúc — luôn lấy từ tool.
- Đấu giá là tính năng riêng, KHÁC với acc bán trực tiếp trong shop (search_accounts) — không nhầm lẫn hai loại.

━━━ CHỢ TRAO ĐỔI (MARKETPLACE P2P) ━━━
- Chợ trao đổi là nơi USER tự đăng bán acc cho nhau.
- Đây không phải là acc do shop trực tiếp bán và khác với search_accounts.

- Các câu như:
  + "chợ trao đổi"
  + "chợ"
  + "chợ acc"
  + "tin đăng bán acc"
  + "acc người khác bán"
  + "acc ký gửi"
  + "acc cộng đồng"
  + "acc user bán"

  → BẮT BUỘC gọi search_marketplace.

- User hỏi chi tiết một tin đăng cụ thể:
  → gọi get_marketplace_listing_detail.

- Thông tin liên hệ người bán chỉ hiển thị khi tin đăng đã được duyệt công khai (APPROVED).

- Nếu tool trả contactInfo = null:
  → báo chưa thể hiển thị thông tin liên hệ.
  → KHÔNG tự bịa thông tin liên hệ.

- KHÔNG được tự bịa:
  + giá bán
  + phí sàn
  + tiền cọc
  + trạng thái duyệt
  + thông tin người bán.

━━━ URL CHỢ TRAO ĐỔI ━━━
- Trang xem danh sách tin đăng:
  /cho-trao-doi

- Trang quản lý và đăng bán acc của user:
  /cho-trao-doi/cua-toi

- Trang chi tiết một tin đăng:
  /cho-trao-doi/{listingId}

- TUYỆT ĐỐI KHÔNG dùng:
  /marketplace
  https://aovshop.vn
  https://aovshop.vn/marketplace

- Luôn ưu tiên đường dẫn tương đối bắt đầu bằng dấu "/".
- Không tự tạo thêm URL hoặc domain không được cung cấp.

- Khi cần chèn link xem các tin đăng trên chợ, sử dụng đúng HTML:
  <a href="/cho-trao-doi" class="text-neon-pink underline font-semibold">Chợ trao đổi</a>

- Khi cần chèn link đăng bán hoặc quản lý tin đăng, sử dụng đúng HTML:
  <a href="/cho-trao-doi/cua-toi" class="text-neon-pink underline font-semibold">Trang quản lý tin đăng</a>

━━━ HƯỚNG DẪN XEM CHỢ TRAO ĐỔI ━━━
Khi user hỏi:
- Xem chợ trao đổi ở đâu?
- Chợ ở đâu?
- Có acc nào người khác bán không?
- Cho xem các tin đăng trên chợ.
- Tôi muốn xem acc cộng đồng.
- Tôi muốn xem chợ.

KHÔNG chỉ trả về một đường link.

Hãy trả lời tự nhiên, giải thích ngắn gọn rồi mới chèn link.

Mẫu trả lời phù hợp:

"Bạn có thể xem các tài khoản đang được người dùng đăng bán tại
<a href="/cho-trao-doi" class="text-neon-pink underline font-semibold">Chợ trao đổi</a>.

Đây là khu vực người chơi tự đăng tin mua bán tài khoản với nhau, khác với các acc do shop trực tiếp bán nhé 😊"

Có thể thay đổi cách diễn đạt cho phù hợp với câu hỏi, nhưng phải:
- giữ đúng URL;
- không chỉ gửi một đường link;
- không tự bịa thông tin;
- không lặp từ thiếu tự nhiên.

━━━ HƯỚNG DẪN ĐĂNG BÁN ACC ━━━
Khi user hỏi:
- Tôi muốn đăng bán acc.
- Tôi có thể đăng bán acc không?
- Tôi muốn bán acc trên shop.
- Đăng acc ở đâu?
- Làm sao đăng bán acc?
- Làm sao up acc bán?
- Up acc bán như thế nào?
- Tôi muốn đăng bài bán acc.
- Quản lý tin đăng của tôi ở đâu?

KHÔNG gọi search_marketplace nếu user chỉ đang hỏi cách đăng bán hoặc vị trí trang quản lý tin đăng.

KHÔNG chỉ trả về một đường link.

Hãy trả lời tự nhiên, giải thích ngắn gọn quy trình rồi mới chèn link.

Mẫu trả lời phù hợp:

"Bạn hoàn toàn có thể đăng bán tài khoản trên shop nhé 😊

Bạn hãy vào
<a href="/cho-trao-doi/cua-toi" class="text-neon-pink underline font-semibold">Trang quản lý tin đăng</a>,
sau đó điền đầy đủ thông tin tài khoản, hình ảnh, giá bán và thông tin liên hệ rồi gửi bài đăng.

Sau khi Admin kiểm duyệt, tin của bạn sẽ được hiển thị trên Chợ trao đổi để người mua có thể xem và liên hệ."

Có thể thay đổi cách diễn đạt cho phù hợp với câu hỏi, nhưng phải bảo đảm:
- giải thích rõ user cần vào đâu;
- nói ngắn gọn các bước đăng tin;
- sử dụng đúng link /cho-trao-doi/cua-toi;
- không bịa điều kiện, phí, tiền cọc hoặc quy trình chưa được cung cấp;
- không trả lời quá cụt.

KHÔNG được trả lời kiểu:
- "Bạn vào Đăng bán acc."
- "Bạn vào Đăng bán acc để đăng bán acc."
- "Đăng bán acc tại Đăng bán acc."
- "Bạn có thể vào Đăng bán acc nhé."

━━━ NẠP TIỀN / QR / THẺ CÀO ━━━
Shop hỗ trợ các cách nạp tiền:
1. QR Pay / chuyển khoản ngân hàng tự động.
2. Nạp bằng thẻ cào điện thoại hoặc thẻ game nếu chức năng đang bật.

- Nếu user hỏi chung "nạp tiền như thế nào", "cách nạp", "nạp sao":
  → Hướng dẫn ngắn gọn cả QR Pay và thẻ cào.

- Nếu user nói "không có ATM", "không có ngân hàng", "không có tài khoản ngân hàng", "không có bank", "không chuyển khoản được", "không có momo", "không có ví điện tử":
  → KHÔNG được bảo user tự quét QR.
  → KHÔNG được mặc định user có tài khoản ngân hàng.
  → Ưu tiên gợi ý:
     1. Nhờ người thân/bạn bè có tài khoản ngân hàng chuyển khoản giúp qua QR của shop.
     2. Nếu không tiện nhờ, dùng thẻ cào điện thoại hoặc thẻ game để nạp nếu shop đang hỗ trợ.
     3. Nếu vẫn không được thì liên hệ hỗ trợ.

Mẫu trả lời khi user không có ATM/ngân hàng:
"Không có ATM hoặc tài khoản ngân hàng cũng không sao bạn nhé 😊

Bạn có thể nhờ người thân/bạn bè chuyển khoản giúp qua mã QR của shop.  
Nếu không tiện nhờ, bạn có thể nạp bằng thẻ cào điện thoại hoặc thẻ game nếu shop đang hỗ trợ.

Bạn đang có sẵn thẻ cào hay có người chuyển khoản giúp không ạ?"

━━━ PHÂN BIỆT NẠP THẺ VÀ MUA THẺ ━━━
1. Nạp thẻ cào vào shop:
- User có sẵn thẻ cào.
- User nhập serial + mã thẻ.
- Hệ thống cộng tiền vào số dư shop.
- Có chiết khấu, số tiền nhận được có thể thấp hơn mệnh giá.

2. Mua thẻ điện thoại / thẻ game từ shop:
- User dùng số dư shop để mua mã thẻ.
- Shop bán thẻ theo giá đã cấu hình.
- Có thể có chiết khấu mua thẻ, user trả ít hơn mệnh giá.

━━━ CHÍNH SÁCH CHIẾT KHẤU THẺ ━━━
- Nạp thẻ cào CÓ chiết khấu, mức tùy loại thẻ + mệnh giá do admin cấu hình.
- Mua thẻ điện thoại / thẻ game cũng có thể có chiết khấu, tùy loại thẻ + mệnh giá.
- Khi user hỏi chiết khấu nạp thẻ, mua thẻ, giá thẻ, nhận bao nhiêu, trả bao nhiêu → BẮT BUỘC gọi get_card_config.
- Nếu user hỏi cụ thể như "mua thẻ Zing 100k chiết khấu sao", "Viettel 50k nhận bao nhiêu":
  → Gọi get_card_config với telco và denomination tương ứng.
- Nếu user hỏi chung chung chưa nói loại thẻ/mệnh giá:
  → Nói chiết khấu tùy loại thẻ và mệnh giá, rồi hỏi user muốn xem loại nào.

QUAN TRỌNG - CHỈ TRẢ LỜI ĐÚNG CHIỀU USER HỎI:
- User hỏi "mua thẻ" / "mua card" / "tốn bao nhiêu" / "trả bao nhiêu" / "giá mua" → CHỈ trả lời giá mua, KHÔNG nói đến nạp thẻ.
- User hỏi "nạp thẻ" / "nạp card" / "nhận bao nhiêu" / "được bao nhiêu" → CHỈ trả lời chiết khấu nạp, KHÔNG nói đến mua thẻ.
- User hỏi cả 2 ("mua và nạp", "nạp thì được bao nhiêu và mua thì mất bao nhiêu") → Trả lời cả 2.
- KHÔNG tự thêm thông tin chiều kia khi user không hỏi.

TUYỆT ĐỐI KHÔNG:
- Không nói "nạp thẻ không có chiết khấu".
- Không bịa phần trăm chiết khấu.
- Không bịa giá mua thẻ.
- Không bảo user tự quét QR khi user vừa nói không có ATM/ngân hàng.

━━━ NGỮ CẢNH THẺ CÀO / MUA THẺ ━━━
Nếu user đã nhắc loại thẻ + mệnh giá trước đó, các câu hỏi sau phải kế thừa thông tin đó.

Ví dụ:
User: "nạp card Viettel 10k được bao nhiêu?"
→ telco = VIETTEL
→ denomination = 10000
→ gọi get_card_config

User tiếp: "nạp thì được bao nhiêu và mua thì mất bao nhiêu?"
→ vẫn hiểu là Viettel 10k
→ KHÔNG hỏi lại
→ gọi get_card_config hoặc dùng CTX.cardConfigs nếu đã có.

Các câu như:
- "nạp thì được bao nhiêu"
- "mua thì mất bao nhiêu"
- "thẻ đó mua giá sao"
- "mệnh giá đó nhận bao nhiêu"

→ phải đọc CTX.cardConfigs trước. Nếu CTX chưa có thì gọi get_card_config.

━━━ GUARDRAILS ━━━
1. KHÔNG bịa số dư, lịch sử nạp, đơn hàng → phải dùng tool.
2. KHÔNG bịa chính sách khi không có trong kiến thức được cung cấp.
3. Tool trả về rỗng → báo rõ, không bịa.

━━━ NGỮ CẢNH PHIÊN (SESSION CONTEXT) ━━━
Phần [CTX] ở cuối tin nhắn này chứa dữ liệu mình đã tra cứu trước đó trong cuộc trò chuyện này.

CÁCH DÙNG [CTX]:
• "acc đó", "tài khoản đó", "mã đó", "loại đó" → đọc CTX.acc
• "đơn hàng đó", "đơn đó" → đọc CTX.orders[0]
• "giao dịch đó", "nạp đó" → đọc CTX.deposits[0]
• "thẻ đó", "mua thẻ đó" → đọc CTX.cards[0]
• Nếu thông tin có trong [CTX] → trả lời NGAY, KHÔNG cần gọi tool lại.
• Nếu [CTX] không có thông tin cần thiết → gọi tool.
• "thẻ đó", "loại thẻ đó", "mệnh giá đó", "nạp thì được bao nhiêu", "mua thì mất bao nhiêu" → đọc CTX.cardConfigs[0]
• "phòng đó", "phòng đấu giá đó", "giá hiện tại của phòng đó" → đọc CTX.auctions[0]
• "tin đó", "tin đăng đó" → đọc CTX.marketplace[0]

━━━ MÃ ACC / MÃ TÚI MÙ ━━━

- Mã sản phẩm của shop có thể chứa chữ, số hoặc kết hợp chữ+số.
- Ví dụ hợp lệ:
  + TB5001
  + AOV123
  + MB5DOL05
  + TM000003

- Khi user gửi hoặc nhắc đến một chuỗi giống mã sản phẩm:
  → KHÔNG được đánh giá định dạng.
  → KHÔNG được nói mã không hợp lệ.
  → KHÔNG được yêu cầu user nhập lại mã nếu user đã cung cấp mã.

- Khi trong tin nhắn có mã sản phẩm hợp lệ:

  Ví dụ:
  + MB5DOL05
  + TM000003
  + TB5001
  + AOV123

  và user hỏi về:
  + acc đó
  + nick đó
  + tài khoản đó
  + mã đó
  + nick đã mua
  + thông tin acc
  + acc còn không
  + acc này thế nào
  + sao không hiện thông tin

  → BẮT BUỘC gọi get_account_detail trước.

- Chỉ được trả lời:
  "Không tìm thấy tài khoản"
  khi get_account_detail trả về không tồn tại.

━━━ TÌM ACC THEO LIÊN KẾT / THÔNG TIN TRẮNG ━━━
Các từ user hay dùng:
- "acc trắng", "thông tin trắng", "trắng thông tin", "chưa liên kết", "không liên kết", "acc sạch"
  → hiểu là acc không email, không SĐT, không Facebook.
  → BẮT BUỘC gọi search_accounts với bindFilter = "WHITE".

- "chỉ có số điện thoại", "chỉ liên kết sđt", "chỉ sđt", "bind sđt", "có sđt thôi"
  → hiểu là acc có SĐT, không email, không Facebook.
  → BẮT BUỘC gọi search_accounts với bindFilter = "PHONE_ONLY".

- "chỉ email", "chỉ có email", "bind email"
  → hiểu là acc có email, không SĐT, không Facebook.
  → BẮT BUỘC gọi search_accounts với bindFilter = "EMAIL_ONLY".

- Nếu user nói "thông tin trắng hoặc chỉ có số điện thoại", "acc trắng hoặc sđt", "trắng hoặc chỉ sđt"
  → BẮT BUỘC gọi search_accounts với bindFilter = "WHITE_OR_PHONE".

QUAN TRỌNG:
- Nếu user chỉ cần tiêu chí liên kết, KHÔNG được hỏi thêm rank/giá/skin/server.
- Nếu user nói "Không chỉ cần như thế thôi", phải dùng tiêu chí đã nói trước đó và gọi search_accounts ngay.
- Khi search_accounts trả về kết quả, trả lời ngắn gọn và để FE render danh sách acc từ toolData.accounts.

━━━ CÁCH DÙNG TOOL ━━━
- Khi user nhắc mã sản phẩm / mã acc / mã túi mù và KHÔNG có trong [CTX] → gọi get_account_detail.
- Khi user hỏi lịch sử nạp → gọi get_deposit_history.
- Khi user hỏi đơn hàng → gọi get_order_history.
- Khi user hỏi thẻ đã mua → gọi get_card_purchase_history.
- Khi user hỏi chiết khấu/giá thẻ/nạp thẻ nhận bao nhiêu/mua thẻ trả bao nhiêu → gọi get_card_config. Nếu user đã nhắc loại thẻ + mệnh giá trước đó thì phải kế thừa, không hỏi lại.
- Khi user hỏi túi mù → gọi get_mystery_box_info.
- Khi user hỏi vòng quay → gọi get_wheel_info.
- Khi user hỏi BXH → gọi get_ranking.
- Khi user tìm acc → gọi search_accounts.
- Khi user hỏi đấu giá / phòng đấu giá → gọi search_auctions. Hỏi chi tiết một phòng → gọi get_auction_detail.
- Khi user hỏi xem chợ trao đổi / tìm tin đăng bán acc P2P → gọi search_marketplace.
- Khi user hỏi chi tiết một tin đăng → gọi get_marketplace_listing_detail.
- Khi user chỉ hỏi cách đăng bán acc hoặc hỏi trang quản lý tin đăng ở đâu → KHÔNG cần gọi search_marketplace, hãy hướng dẫn và trả đúng link /cho-trao-doi/cua-toi.

━━━ DOMAIN VÀ URL NỘI BỘ ━━━
- Domain chính thức của shop là https://aovshop.id.vn
- Trang Chợ trao đổi là:
  https://aovshop.id.vn/cho-trao-doi
- Trang đăng bán và quản lý tin của user là:
  https://aovshop.id.vn/cho-trao-doi/cua-toi
- Trang chi tiết tin đăng có dạng:
  https://aovshop.id.vn/cho-trao-doi/{listingId}

- TUYỆT ĐỐI KHÔNG dùng:
  /marketplace
  https://aovshop.vn
  https://aovshop.vn/marketplace

- Ưu tiên đường dẫn tương đối bắt đầu bằng dấu "/", không tự tạo domain khác.

- Khi user hỏi xem chợ trao đổi, chèn link:
  <a href="/cho-trao-doi" class="text-neon-pink underline font-semibold">Chợ trao đổi</a>

- Khi user hỏi đăng bài bán acc hoặc quản lý tin đăng, chèn link:
  <a href="/cho-trao-doi/cua-toi" class="text-neon-pink underline font-semibold">Trang quản lý tin đăng</a>

- Link phải được đặt trong một câu trả lời tự nhiên và có hướng dẫn rõ ràng.
- Không chỉ trả về riêng thẻ <a>.
- Không sử dụng chính nội dung link để lặp lại câu theo kiểu:
  "vào Đăng bán acc để đăng bán acc".

━━━ FORMAT TRẢ LỜI ━━━
Trả lời tự nhiên, thân thiện. Khi có sản phẩm: ngắn gọn kèm giá.
Khi không có kết quả: báo rõ và gợi ý điều chỉnh.
`

/* ── Build system prompt với RAG + summary ─────────── */
function buildSystemPrompt(ragContext, summary) {
  let prompt = SYSTEM_PROMPT_BASE

  if (summary) {
    prompt += `\n━━━ TÓM TẮT PHIÊN ━━━\n${summary}\n`
  }

  if (ragContext?.length > 0) {
    const labels = { FAQ: 'Câu hỏi thường gặp', POLICY: 'Chính sách', GUIDE: 'Hướng dẫn', TERM: 'Điều khoản' }
    const blocks = ragContext.map((item, i) =>
      `[${i + 1}] ${labels[item.type] || item.type}: ${item.title}\n${item.content}`
    ).join('\n\n---\n\n')
    prompt += `\n━━━ KIẾN THỨC SHOP LIÊN QUAN ━━━\n${blocks}\n━━━ HẾT KIẾN THỨC ━━━\n`
  }

  return prompt
}

/* ── Serialize in-memory context → text block ────────
 * Gemini đọc [CTX] này để trả lời follow-up mà không gọi tool lại.
 * Format ngắn gọn, rõ ràng, dễ parse hơn là inject raw JSON.
 */
function buildCtxBlock(ctx) {
  if (!ctx) return null

  const lines = []

  if (ctx.lastAcc) {
    const a = ctx.lastAcc
    const accLines = [
      `  code: ${a.code || '?'}`,
      `  title: ${a.title || '?'}`,
    ]
    if (a.type) accLines.push(`  type: ${a.type}`)
    if (a.rank) accLines.push(`  rank: ${a.rank}`)
    if (a.price != null) accLines.push(`  price: ${Number(a.price).toLocaleString('vi-VN')}đ`)
    if (a.skins != null) accLines.push(`  skins: ${a.skins}`)
    if (a.champions != null) accLines.push(`  champions: ${a.champions}`)
    if (a.status) accLines.push(`  status: ${a.status}`)
    if (a.gameBindFacebook) accLines.push(`  fb: ${a.gameBindFacebook}`)
    if (a.hasEmail != null) accLines.push(`  hasEmail: ${a.hasEmail}`)
    if (a.hasPhone != null) accLines.push(`  hasPhone: ${a.hasPhone}`)
    if (a.categoryName) accLines.push(`  category: ${a.categoryName}`)
    if (a.rarity) accLines.push(`  rarity: ${a.rarity}`)
    if (a.canViewDetail != null) accLines.push(`  canViewOnShop: ${a.canViewDetail}`)
    lines.push('acc:')
    lines.push(...accLines)
  }

  if (ctx.lastOrders?.length) {
    lines.push('orders:')
    ctx.lastOrders.slice(0, 3).forEach(o => {
      lines.push(`  - ${o.orderCode} | ${o.status} | ${Number(o.finalAmount).toLocaleString('vi-VN')}đ`)
      o.items?.slice(0, 1).forEach(i => lines.push(`    item: ${i.code} ${i.title} (${i.rank})`))
    })
  }

  if (ctx.lastDeposits?.length) {
    lines.push('deposits:')
    ctx.lastDeposits.slice(0, 3).forEach(d => {
      lines.push(`  - ${Number(d.amount).toLocaleString('vi-VN')}đ | ${d.status} | ${d.method}`)
    })
  }

  if (ctx.lastCards?.length) {
    lines.push('cards:')
    ctx.lastCards.slice(0, 3).forEach(c => {
      lines.push(`  - ${c.telco} ${Number(c.denomination).toLocaleString('vi-VN')}đ x${c.quantity} | ${c.status}`)
    })
  }

  if (ctx.lastCardConfigs?.length) {
    lines.push('cardConfigs:')
    ctx.lastCardConfigs.slice(0, 5).forEach(c => {
      const buyInfo = c.buyEnabled ? `mua=${Number(c.buyPrice).toLocaleString('vi-VN')}đ(CK ${c.buyDiscount}%)` : ''
      const depositInfo = c.depositEnabled ? `nạp=${Number(c.depositReceive).toLocaleString('vi-VN')}đ(CK ${c.depositDiscount}%)` : ''
      lines.push(`  - ${c.telcoLabel || c.telco} ${Number(c.denomination).toLocaleString('vi-VN')}đ: ${[depositInfo, buyInfo].filter(Boolean).join(', ')}`)
    })
  }

  if (ctx.lastMysteryBoxes?.length) {
    lines.push('mysteryBoxes:')
    ctx.lastMysteryBoxes.slice(0, 3).forEach(b => {
      lines.push(`  - ${b.name} | ${b.rarity} | ${Number(b.price).toLocaleString('vi-VN')}đ | còn ${b.availableCount}`)
    })
  }

  if (ctx.lastWheel) {
    const w = ctx.lastWheel
    lines.push(`wheel: ${w.name} | chi phí ${Number(w.spinCost).toLocaleString('vi-VN')}đ/lượt`)
  }

  if (ctx.lastRankings?.length) {
    lines.push('rankings:')
    ctx.lastRankings.slice(0, 3).forEach((r, i) =>
      lines.push(`  ${i + 1}. ${r.username} – ${Number(r.totalDeposit).toLocaleString('vi-VN')}đ`)
    )
  }

  if (ctx.lastAuctions?.length) {
    lines.push('auctions:')
    ctx.lastAuctions.slice(0, 5).forEach(a => {
      const cur = Number(a.currentPrice ?? a.startingPrice).toLocaleString('vi-VN')
      lines.push(`  - ${a.title} | ${a.status} | giá hiện tại: ${cur}đ | tổng lượt bid: ${a.totalBids ?? 0}`)
    })
  }

  if (ctx.lastMarketplace?.length) {
    lines.push('marketplace:')
    ctx.lastMarketplace.slice(0, 5).forEach(m => {
      lines.push(`  - ${m.title} | ${Number(m.price).toLocaleString('vi-VN')}đ | người bán: ${m.seller || '?'} | fullInfo: ${m.hasFullInfo}`)
    })
  }

  return lines.length > 0 ? `[CTX]\n${lines.join('\n')}\n[/CTX]` : null
}

/* ── Convert DB messages → Gemini history ────────────
 * Chỉ lấy messages đã lưu trong DB (không bao gồm user msg hiện tại).
 * User msg hiện tại sẽ được thêm riêng ở dưới, kèm [CTX].
 */
function historyToGeminiContents(dbMessages) {
  return dbMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/* ── Gọi Gemini ──────────────────────────────────── */
async function callGemini(systemPrompt, contents, useTools = true) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Thiếu GEMINI_API_KEY')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.35, maxOutputTokens: 2048 },
    contents,
  }
  if (useTools) body.tools = [{ functionDeclarations: TOOL_DECLARATIONS }]

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini ${res.status}: ${errText}`)
  }
  return res.json()
}

/* ── Auto-generate title ─────────────────────────── */
async function autoGenerateTitle(sessionId, text) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: { temperature: 0.2, maxOutputTokens: 20 },
          contents: [{ role: 'user', parts: [{ text: `Tóm tắt thành tiêu đề ngắn tối đa 6 từ tiếng Việt, không dấu chấm:\n"${text.slice(0, 200)}"` }] }],
        }),
      }
    )
    const data = await res.json()
    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (title) {
      const finalTitle = title.slice(0, 100)

      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { title: finalTitle },
      })

      return finalTitle
    }
  } catch (err) {
    logger.warn('[Chat] autoGenerateTitle:', err.message)
  }
}

/* ── Normalize account detail ────────────────────── */
function normalizeAcc(acc) {
  if (!acc) return acc

  if (acc.error) {
    return null
  }

  const canView = acc.type === 'GAME_ACCOUNT' && acc.status === 'AVAILABLE'

  const safeAcc = { ...acc }

  delete safeAcc.gameUsername
  delete safeAcc.gamePassword
  delete safeAcc.gameBindInfo
  delete safeAcc.gameBindEmail
  delete safeAcc.gameBindPhone

  return {
    ...safeAcc,
    canViewDetail: canView,
  }
}

/* ── Build FE response data ──────────────────────── */
function buildResponseData(toolCallsMade, reply, sessionId) {
  const data = {
    sessionId, reply, intent: 'chat',
    accounts: [], mysteryBoxes: [], wheel: null,
    deposits: [], orders: [], cardPurchases: [],
    rankings: [], accountDetail: null, cardConfigs: [],
    auctions: [], auctionDetail: null,
    marketplaceListings: [], marketplaceDetail: null,
  }

  for (const tc of toolCallsMade) {
    switch (tc.tool) {
      case 'search_accounts': {
        const newAccounts = (tc.result?.accounts || []).map(a => ({ ...a, canViewDetail: true }))
        // Chỉ ghi đè nếu chưa có kết quả, hoặc kết quả mới nhiều hơn (tránh Gemini gọi lại override kết quả forced)
        if (data.accounts.length === 0 || newAccounts.length > data.accounts.length) {
          data.intent = 'search_accounts'
          data.accounts = newAccounts
        }
        break
      }
      case 'get_account_detail':
        data.intent = 'account_detail'

        if (!tc.result?.error) {
          data.accountDetail = normalizeAcc(tc.result)
        }

        break
      case 'get_deposit_history':
        data.intent = 'deposit_history'
        data.deposits = tc.result?.deposits || []
        break
      case 'get_order_history':
        data.intent = 'order_history'
        data.orders = tc.result?.orders || []
        break
      case 'get_card_purchase_history':
        data.intent = 'card_history'
        data.cardPurchases = tc.result?.purchases || []
        break
      case 'get_mystery_box_info':
        data.intent = 'mystery_box'
        data.mysteryBoxes = tc.result?.mysteryBoxes || []
        break
      case 'get_wheel_info':
        data.intent = 'wheel'
        data.wheel = tc.result?.wheel || null
        break
      case 'get_ranking':
        data.intent = 'ranking'
        data.rankings = tc.result?.rankings || []
        break
      case 'get_card_config':
        data.intent = 'card_config'
        data.cardConfigs = tc.result?.configs || []
        break
      case 'search_auctions':
        data.intent = 'auctions'
        data.auctions = tc.result?.auctions || []
        break
      case 'get_auction_detail':
        data.intent = 'auction_detail'
        if (!tc.result?.error && tc.result?.found !== false) {
          data.auctionDetail = tc.result
        }
        break
      case 'search_marketplace':
        data.intent = 'marketplace'
        data.marketplaceListings = tc.result?.listings || []
        break
      case 'get_marketplace_listing_detail':
        data.intent = 'marketplace_detail'
        if (!tc.result?.error && tc.result?.found !== false) {
          data.marketplaceDetail = tc.result
        }
        break
    }
  }
  return data
}

/* ── Fallback reply ──────────────────────────────── */
function detectCardIntent(text = '') {
  const s = text.toLowerCase()
  // Signals rõ ràng là "mua thẻ từ shop"
  const buySignals = ['mua thẻ', 'mua card', 'mua mã', 'mua vào', 'trả bao nhiêu', 'tốn bao nhiêu', 'giá mua', 'mua thì', 'mua hết bao', 'mất bao nhiêu', 'mua bao nhiêu']
  // Signals rõ ràng là "nạp thẻ vào shop"
  const depositSignals = ['nạp thẻ', 'nạp card', 'nộp thẻ', 'nhận bao nhiêu', 'được bao nhiêu', 'nạp vào', 'nạp thì', 'nạp thì được', 'chiết khấu nạp']

  const isBuy = buySignals.some(w => s.includes(w))
  const isDeposit = depositSignals.some(w => s.includes(w))

  if (isBuy && !isDeposit) return 'buy'
  if (isDeposit && !isBuy) return 'deposit'
  return 'both' // hỏi cả 2 hoặc không rõ
}

function fallbackReply(toolCallsMade, userText = '') {
  const last = toolCallsMade.at(-1)
  if (!last) return 'Mình chưa có đủ thông tin, bạn nói rõ hơn nhé.'

  const map = {
    search_accounts: r => r.accounts?.length ? `Tìm được ${r.accounts.length} acc.` : 'Không tìm thấy acc nào phù hợp.',
    get_account_detail: r => {
      if (r.error === 'ACCESS_DENIED') {
        return 'Mã acc này thuộc về người dùng khác hoặc bạn không có quyền xem thông tin.'
      }

      if (r.error) {
        return 'Không tìm thấy tài khoản này.'
      }

      return `Tìm thấy tài khoản ${r.code || r.id} rồi nè.`
    },
    get_deposit_history: r => r.deposits?.length ? `Tìm thấy ${r.deposits.length} giao dịch nạp.` : 'Chưa có lịch sử nạp.',
    get_order_history: r => r.orders?.length ? `Tìm thấy ${r.orders.length} đơn hàng.` : 'Chưa có đơn hàng.',
    get_card_purchase_history: r => r.purchases?.length ? `Tìm thấy ${r.purchases.length} lần mua thẻ.` : 'Chưa có lịch sử mua thẻ.',
    get_mystery_box_info: r => r.mysteryBoxes?.length ? `Có ${r.mysteryBoxes.length} loại túi mù.` : 'Chưa có túi mù.',
    get_wheel_info: r => r.wheel ? 'Vòng quay đang hoạt động.' : 'Chưa có vòng quay.',
    get_ranking: r => r.rankings?.length ? 'Đây là BXH nạp tiền.' : 'Chưa có dữ liệu BXH.',
    get_card_config: r => {
      const c = r.configs?.[0]

      if (!r.found || !c) {
        return r.message || 'Không tìm thấy cấu hình thẻ này.'
      }

      const denom = Number(c.denomination).toLocaleString('vi-VN')
      const telco = c.telcoLabel || c.telco
      const intent = detectCardIntent(userText)

      const depositText = c.depositEnabled
        ? `Nếu nạp thẻ ${telco} ${denom}đ vào shop, bạn nhận được ${Number(c.depositReceive).toLocaleString('vi-VN')}đ sau chiết khấu ${c.depositDiscount}%.`
        : `Thẻ ${telco} ${denom}đ hiện chưa hỗ trợ nạp vào shop.`

      const buyText = c.buyEnabled
        ? `Mua thẻ ${telco} ${denom}đ từ shop, bạn chỉ cần trả ${Number(c.buyPrice).toLocaleString('vi-VN')}đ (chiết khấu ${c.buyDiscount}%).`
        : `Thẻ ${telco} ${denom}đ hiện chưa mở bán trên shop.`

      if (intent === 'buy') return buyText
      if (intent === 'deposit') return depositText
      return `${buyText}\n\n${depositText}`
    },
  }

  const fn = map[last.tool]
  return fn ? fn(last.result) : 'Mình đã xử lý xong yêu cầu.'
}

/* ══════════════════════════════════════════════════════════
   MAIN HANDLER
   ══════════════════════════════════════════════════════════ */
function parseMoneyText(text = '') {
  const s = String(text || '').toLowerCase()

  const m1 = s.match(/(\d+)\s*(k|nghìn|ngàn)/i)
  if (m1) return Number(m1[1]) * 1000

  const m2 = s.match(/(\d{4,})/)
  if (m2) return Number(m2[1])

  return null
}

function detectTelco(text = '') {
  const s = String(text || '').toLowerCase()

  if (s.includes('viettel') || s.includes('việt theo') || s.includes('viet theo') || s.includes('việt teo')) return 'VIETTEL'
  if (s.includes('vina') || s.includes('vinaphone')) return 'VINAPHONE'
  if (s.includes('mobi') || s.includes('mobifone')) return 'MOBIFONE'
  if (s.includes('zing')) return 'ZING'
  if (s.includes('garena')) return 'GARENA'
  if (s.includes('gate')) return 'GATE'
  if (s.includes('vcoin')) return 'VCOIN'

  return null
}

function detectBindFilter(text = '') {
  const s = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  const hasWhite =
    s.includes('thong tin trang') ||
    s.includes('trang thong tin') ||
    s.includes('acc trang') ||
    s.includes('nick trang') ||
    s.includes('chua lien ket') ||
    s.includes('khong lien ket') ||
    s.includes('ko lien ket') ||
    s.includes('k lien ket') ||
    s.includes('khong lk') ||
    s.includes('ko lk') ||
    s.includes('acc sach')

  const hasPhoneOnly =
    s.includes('chi co so dien thoai') ||
    s.includes('chi co sdt') ||
    s.includes('chi sdt') ||
    s.includes('chi lien ket sdt') ||
    s.includes('bind sdt') ||
    s.includes('co sdt thoi') ||
    s.includes('co so dien thoai thoi')

  const hasEmailOnly =
    s.includes('chi email') ||
    s.includes('chi co email') ||
    s.includes('bind email') ||
    s.includes('co email thoi') ||
    s.includes('chi co mail') ||
    s.includes('bind mail') ||
    s.includes('co mail thoi')

  if (hasWhite && hasPhoneOnly) return 'WHITE_OR_PHONE'
  if (hasPhoneOnly) return 'PHONE_ONLY'
  if (hasEmailOnly) return 'EMAIL_ONLY'
  if (hasWhite) return 'WHITE'

  return null
}

function shouldForceWheelInfo(text = '') {
  const s = String(text || '').toLowerCase()

  return (
    s.includes('vòng quay') ||
    s.includes('lucky wheel') ||
    s.includes('quay may mắn') ||
    s.includes('quay thưởng') ||
    s.includes('bao nhiêu tiền 1 lượt') ||
    s.includes('bao nhiêu tiền một lượt') ||
    s.includes('phần thưởng là gì')
  )
}

function shouldForceAccountSearch(userText = '', historyMsgs = []) {
  const current = String(userText || '').trim().toLowerCase()

  const isConfirm =
    current === 'ok' ||
    current === 'oke' ||
    current === 'ừ' ||
    current === 'uh' ||
    current === 'đúng' ||
    current === 'đúng rồi' ||
    current === 'tìm đi' ||
    current === 'tìm kiếm đi' ||
    current === 'không chỉ cần như thế thôi' ||
    current.includes('chỉ cần như thế')

  const recentText = historyMsgs
    .slice(-6)
    .map(m => m.content)
    .join('\n')

  const textToDetect = isConfirm
    ? `${recentText}\n${userText}`
    : userText

  const bindFilter = detectBindFilter(textToDetect)

  if (!bindFilter) return null

  return {
    bindFilter,
    sort: 'newest',
    limit: 5,
  }
}

function shouldForceCardConfig(text = '') {
  const s = String(text || '').toLowerCase()

  const hasCardIntent =
    s.includes('thẻ') ||
    s.includes('card') ||
    s.includes('mua') ||
    s.includes('nạp') ||
    s.includes('nhận bao nhiêu') ||
    s.includes('mất bao nhiêu') ||
    s.includes('chiết khấu') ||
    s.includes('giá bao nhiêu')

  const telco = detectTelco(s)
  const denomination = parseMoneyText(s)

  if (!hasCardIntent || !telco || !denomination) return null

  return { telco, denomination }
}

function detectAccountCode(text = '') {
  const s = String(text || '').toUpperCase()

  const matches = s.match(/\b[A-Z0-9]{5,20}\b/g) || []

  const ignoreWords = new Set([
    'VIETTEL',
    'VINAPHONE',
    'MOBIFONE',
    'VIETNAMOBILE',
    'GMOBILE',
    'REDDI',
    'GARENA',
    'ZING',
    'GATE',
    'VCOIN',
    'SHOP',
    'GAME',
    'BANK',
  ])

  return matches.find(code => {
    const hasLetter = /[A-Z]/.test(code)
    const hasNumber = /\d/.test(code)

    return hasLetter && hasNumber && !ignoreWords.has(code)
  }) || null
}

function shouldForceAccountDetail(text = '') {
  const s = String(text || '').toLowerCase()

  const code = detectAccountCode(text)

  if (!code) return null

  const hasIntent =
    s.includes('acc') ||
    s.includes('nick') ||
    s.includes('tài khoản') ||
    s.includes('thông tin') ||
    s.includes('đã mua') ||
    s.includes('mua') ||
    s.includes('mã') ||
    s.includes('không hiện') ||
    s.includes('không thấy')

  if (!hasIntent) return null

  return {
    accountCode: code,
  }
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

const sendMessage = async (req, res) => {
  try {
    const { sessionId: rawSessionId, message } = req.body
    const userId = req.user.id

    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'message là bắt buộc' })
    }

    const userText = message.trim()

    /* ── 1. Tìm/tạo session ──────────────────────── */
    let sessionId = rawSessionId
    let session

    if (sessionId) {
      session = await prisma.chatSession.findFirst({
        where: { id: sessionId, userId },
        select: { id: true, title: true, summary: true, _count: { select: { messages: true } } },
      })

      if (!session) {
        return res.status(404).json({ success: false, message: 'Session không tồn tại' })
      }
    } else {
      session = await prisma.chatSession.create({
        data: { userId },
        select: { id: true, title: true, summary: true, _count: { select: { messages: true } } },
      })
      sessionId = session.id
    }

    const isFirst = session._count.messages === 0

    /* ── 2. Lưu user message ─────────────────────── */
    await prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'user',
        content: userText,
      },
    })

    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    })

    /* ── 3. Lấy history từ DB, bỏ user msg vừa thêm ─ */
    const allMsgs = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true, createdAt: true },
    })

    const historyMsgs = allMsgs.slice(0, -1).slice(-HISTORY_LIMIT)

    /* ── 4. Lấy in-memory context ────────────────── */
    const ctx = memStore.getContext(sessionId, userId)

    /* ── 5. RAG Pinecone ─────────────────────────── */
    let ragContext = []
    if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
      try {
        ragContext = await searchSimilar(userText, 4, 0.62)
      } catch (err) {
        logger.warn('[Chat] Pinecone failed:', err.message)
      }
    }

    /* ── 6. Build Gemini contents ────────────────── */
    const systemPrompt = buildSystemPrompt(ragContext, session.summary)
    const historyContents = historyToGeminiContents(historyMsgs)
    const ctxBlock = buildCtxBlock(ctx)

    const userMsgText = ctxBlock
      ? `${userText}\n\n${ctxBlock}`
      : userText

    const contents = [
      ...historyContents,
      { role: 'user', parts: [{ text: userMsgText }] },
    ]

    /* ── 7. Agentic Tool Calling Loop ────────────── */
    let finalReply = ''
    const toolCallsMade = []
    let iteration = 0
    let currentContents = contents

    const forcedAcc = shouldForceAccountDetail(userText)

    if (forcedAcc) {
      let result = await executeTool(
        'get_account_detail',
        forcedAcc,
        userId
      )

      result = normalizeAcc(result)

      toolCallsMade.push({
        tool: 'get_account_detail',
        args: forcedAcc,
        result,
      })

      memStore.updateContextFromToolResults(sessionId, userId, toolCallsMade)

      // Inject tool result vào contents để Gemini tổng hợp câu trả lời
      currentContents = [
        ...currentContents,
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'get_account_detail',
              response: { result: JSON.stringify(result) },
            },
          }],
        },
      ]
    }

    /* 
      ÉP gọi get_card_config trước Gemini nếu user hỏi thẻ + mệnh giá.
      Fix case typo: "việt theo 10k", "viet theo 10 nghìn"...
    */
    const forcedCard = shouldForceCardConfig(userText)

    if (!forcedAcc && forcedCard) {
      const result = await executeTool('get_card_config', forcedCard, userId)

      toolCallsMade.push({
        tool: 'get_card_config',
        args: forcedCard,
        result,
      })

      memStore.updateContextFromToolResults(sessionId, userId, toolCallsMade)

      currentContents = [
        ...currentContents,
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'get_card_config',
              response: { result: JSON.stringify(result) },
            },
          }],
        },
      ]
    }

    const forcedWheel = shouldForceWheelInfo(userText)

if (!forcedAcc && !forcedCard && forcedWheel) {
  const result = await executeTool(
    'get_wheel_info',
    {},
    userId
  )

  toolCallsMade.push({
    tool: 'get_wheel_info',
    args: {},
    result,
  })

  memStore.updateContextFromToolResults(sessionId, userId, toolCallsMade)

  finalReply = result.wheel
    ? `Đây là thông tin vòng quay may mắn hiện tại nè 🎡`
    : 'Hiện tại shop chưa có vòng quay may mắn nào đang hoạt động.'

  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: 'assistant',
      content: finalReply,
      metadata: JSON.stringify({
        toolCalls: toolCallsMade.map(t => ({ tool: t.tool, args: t.args })),
        forced: true,
      }),
    },
  })

  return res.json({
    success: true,
    sessionTitle: null,
    data: buildResponseData(
      toolCallsMade,
      finalReply,
      sessionId
    ),
  })
}

    // const forcedAccountSearch = shouldForceAccountSearch(userText, historyMsgs)

    // if (!forcedAcc && !forcedCard && forcedAccountSearch) {
    //   const result = await executeTool(
    //     'search_accounts',
    //     forcedAccountSearch,
    //     userId
    //   )

    //   toolCallsMade.push({
    //     tool: 'search_accounts',
    //     args: forcedAccountSearch,
    //     result,
    //   })

    //   memStore.updateContextFromToolResults(sessionId, userId, toolCallsMade)

    //   currentContents = [
    //     ...currentContents,
    //     {
    //       role: 'user',
    //       parts: [{
    //         functionResponse: {
    //           name: 'search_accounts',
    //           response: { result: JSON.stringify(result) },
    //         },
    //       }],
    //     },
    //   ]
    // }
    const forcedAccountSearch = shouldForceAccountSearch(userText, historyMsgs)

if (!forcedAcc && !forcedCard && !forcedWheel && forcedAccountSearch) {
  const result = await executeTool(
    'search_accounts',
    forcedAccountSearch,
    userId
  )

  toolCallsMade.push({
    tool: 'search_accounts',
    args: forcedAccountSearch,
    result,
  })

  memStore.updateContextFromToolResults(sessionId, userId, toolCallsMade)

  finalReply = result.accounts?.length
    ? `Tìm được ${result.accounts.length} acc phù hợp nè 😊`
    : 'Không tìm thấy acc nào phù hợp.'

  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: 'assistant',
      content: finalReply,
      metadata: JSON.stringify({
        toolCalls: toolCallsMade.map(t => ({ tool: t.tool, args: t.args })),
        forced: true,
      }),
    },
  })

  return res.json({
    success: true,
    sessionTitle: null,
    data: buildResponseData(
      toolCallsMade,
      finalReply,
      sessionId
    ),
  })
}

    while (!finalReply && iteration < MAX_TOOL_ITERATIONS) {
      iteration++

      const data = await callGemini(systemPrompt, currentContents, true)
      const candidate = data.candidates?.[0]

      if (!candidate) {
        throw new Error('Gemini không trả về candidate')
      }

      const parts = candidate.content?.parts || []
      const finishReason = candidate.finishReason
      const toolParts = parts.filter(p => p.functionCall)
      const textParts = parts.filter(p => p.text)

      if (toolParts.length === 0) {
          finalReply = textParts.map(p => p.text).join('').trim()
          break
      }

      const results = await Promise.all(
        toolParts.map(async part => {
          const { name, args } = part.functionCall

          let finalArgs = args || {}

          /*
            Nếu Gemini gọi search_accounts mà đã có forcedAccountSearch trước đó,
            bắt buộc kế thừa bindFilter từ forced args để Gemini không override.
          */
          if (name === 'search_accounts' && forcedAccountSearch) {
            finalArgs = {
              ...finalArgs,
              bindFilter: finalArgs.bindFilter || forcedAccountSearch.bindFilter,
            }
          }

          /*
            Nếu Gemini gọi get_card_config nhưng thiếu telco/mệnh giá,
            thử lấy lại từ câu user hiện tại.
          */
          if (name === 'get_card_config') {
            const detected = shouldForceCardConfig(userText)
            if (detected) {
              finalArgs = {
                ...finalArgs,
                telco: finalArgs.telco || detected.telco,
                denomination: finalArgs.denomination || detected.denomination,
              }
            }
          }

          let result = await executeTool(name, finalArgs, userId)

          if (name === 'get_account_detail') {
            result = normalizeAcc(result)
          }

          toolCallsMade.push({
            tool: name,
            args: finalArgs,
            result,
          })

          return { name, result }
        })
      )

      memStore.updateContextFromToolResults(sessionId, userId, toolCallsMade)

      currentContents = [
        ...currentContents,
        { role: 'model', parts },
        {
          role: 'user',
          parts: results.map(r => ({
            functionResponse: {
              name: r.name,
              response: { result: JSON.stringify(r.result) },
            },
          })),
        },
      ]
    }

    if (!finalReply) {
      finalReply = fallbackReply(toolCallsMade, userText)
    }

      finalReply = normalizeChatLinks(finalReply)
    /* ── 8. Lưu assistant message ────────────────── */
    await prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: finalReply,
        metadata: JSON.stringify({
          toolCalls: toolCallsMade.map(t => ({ tool: t.tool, args: t.args })),
          ragContextCount: ragContext.length,
        }),
      },
    })

    /* ── 9. Auto title ───────────────────────────── */
    let generatedTitle = null

    if (isFirst) {
      try {
        generatedTitle = await autoGenerateTitle(
          sessionId,
          userText
        )
      } catch (err) {
        logger.warn('[AUTO_TITLE]', err.message)
      }
    }

    return res.json({
      success: true,
      sessionTitle: generatedTitle,
      data: buildResponseData(
        toolCallsMade,
        finalReply,
        sessionId
      ),
    })
  } catch (err) {
    logger.error('[Chat] sendMessage error:', err)

    return res.status(500).json({
      success: false,
      message: 'Lỗi xử lý tin nhắn',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    })
  }
}

module.exports = { sendMessage }