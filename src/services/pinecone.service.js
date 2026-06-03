/**
 * pinecone.service.js
 * ─────────────────────────────────────────────────────────────────────────
 * Chịu trách nhiệm:
 *  1. Tạo embedding bằng Gemini text-embedding-004
 *  2. Upsert / delete vector trên Pinecone Cloud
 *  3. Query similarity search để RAG chatbot dùng
 *
 * Thiết kế:
 *  - MySQL/Prisma giữ dữ liệu gốc (source of truth)
 *  - Pinecone chỉ chứa vector + metadata tối thiểu để search
 *  - vectorId = AiKnowledge.id (1-1 mapping, dễ update/delete)
 * ─────────────────────────────────────────────────────────────────────────
 */

const { Pinecone } = require('@pinecone-database/pinecone')
const logger = require('../config/logger')

/* ── Khởi tạo Pinecone client (singleton) ────────────────── */
let _pineconeClient = null
let _pineconeIndex  = null

function getPineconeClient() {
  if (!_pineconeClient) {
    const apiKey = process.env.PINECONE_API_KEY
    if (!apiKey) throw new Error('PINECONE_API_KEY chưa được cấu hình trong .env')

    _pineconeClient = new Pinecone({ apiKey })
  }
  return _pineconeClient
}

async function getPineconeIndex() {
  if (!_pineconeIndex) {
    const client    = getPineconeClient()
    const indexName = process.env.PINECONE_INDEX_NAME

    if (!indexName) throw new Error('PINECONE_INDEX_NAME chưa được cấu hình trong .env')

    _pineconeIndex = client.index(indexName)
  }
  return _pineconeIndex
}

/* ── Gemini Embedding ─────────────────────────────────────── */
/**
 * Tạo embedding vector cho một đoạn văn bản
 * Model: text-embedding-004 (768 dimensions)
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function createEmbedding(text) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
    }),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Gemini Embedding API lỗi ${res.status}: ${errBody}`)
  }

  const data = await res.json()
  return data.embedding.values
}

/**
 * Tạo embedding cho query của user khi search
 * taskType RETRIEVAL_QUERY tối ưu hơn cho phía query
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function createQueryEmbedding(text) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY chưa được cấu hình')

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: 768,
    }),
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Gemini Query Embedding lỗi ${res.status}: ${errBody}`)
  }

  const data = await res.json()
  return data.embedding.values
}

/* ── Pinecone Upsert ─────────────────────────────────────── */
/**
 * Upsert một batch records vào Pinecone
 * Mỗi record: { id, title, type, content }
 * vectorId = record.id
 *
 * @param {Array<{id:string, title:string, type:string, content:string}>} records
 * @param {function(number, number):void} [onProgress] - callback(done, total)
 * @returns {Promise<{success: number, failed: number, errors: string[]}>}
 */
async function upsertKnowledgeVectors(records, onProgress) {
  const index   = await getPineconeIndex()
  const total   = records.length
  let   success = 0
  let   failed  = 0
  const errors  = []

  // Xử lý từng record tuần tự để tránh rate limit Gemini Embedding
  // Production: có thể tăng lên batch nhỏ (3-5) với Promise.all + delay
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]

    try {
      // Ghép title + content để embedding có ngữ cảnh đầy đủ
      const textToEmbed = `${rec.title}\n\n${rec.content}`
      const vector      = await createEmbedding(textToEmbed)

      await index.upsert([{
        id    : rec.id,          // vectorId = AiKnowledge.id
        values: vector,
        metadata: {
          knowledgeId: rec.id,
          title      : rec.title,
          type       : rec.type,
          // Lưu preview content để khi search trả về có thể dùng ngay
          // Giới hạn 1000 chars vì Pinecone metadata có limit
          contentSnippet: rec.content.slice(0, 1000),
        },
      }])

      success++
      logger.info(`[Pinecone] Upsert OK: ${rec.id} (${rec.title})`)
    } catch (err) {
      failed++
      const msg = `Lỗi upsert [${rec.id}] ${rec.title}: ${err.message}`
      errors.push(msg)
      logger.error(`[Pinecone] ${msg}`)
    }

    if (onProgress) onProgress(i + 1, total)

    // Delay nhỏ để tránh hit rate limit Gemini Embedding API
    if (i < records.length - 1) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  return { success, failed, errors }
}

/**
 * Xóa vector khỏi Pinecone theo danh sách IDs
 * @param {string[]} vectorIds
 */
async function deleteVectors(vectorIds) {
  if (!vectorIds || vectorIds.length === 0) return
  const index = await getPineconeIndex()
  await index.deleteMany(vectorIds)
  logger.info(`[Pinecone] Đã xóa ${vectorIds.length} vector(s)`)
}

/* ── Similarity Search (RAG) ─────────────────────────────── */
/**
 * Tìm kiếm ngữ nghĩa trong Pinecone
 * Trả về top-k kết quả phù hợp nhất với query
 *
 * @param {string} query           - Câu hỏi của user
 * @param {number} [topK=4]        - Số kết quả trả về
 * @param {number} [minScore=0.65] - Ngưỡng score tối thiểu (0-1)
 * @returns {Promise<Array<{id, title, type, content, score}>>}
 */
async function searchSimilar(query, topK = 4, minScore = 0.65) {
  try {
    const index       = await getPineconeIndex()
    const queryVector = await createQueryEmbedding(query)

    const results = await index.query({
      vector         : queryVector,
      topK,
      includeMetadata: true,
    })

    const matches = (results.matches || [])
      .filter(m => m.score >= minScore)
      .map(m => ({
        id     : m.id,
        title  : m.metadata?.title          || '',
        type   : m.metadata?.type           || '',
        content: m.metadata?.contentSnippet || '',
        score  : m.score,
      }))

    logger.info(`[Pinecone] Search "${query.slice(0, 50)}" → ${matches.length} kết quả`)
    return matches
  } catch (err) {
    logger.error(`[Pinecone] searchSimilar error: ${err.message}`)
    return [] // Fallback: trả về mảng rỗng, chatbot sẽ dùng Gemini thuần
  }
}

/**
 * Kiểm tra kết nối Pinecone + lấy thống kê index
 */
async function getIndexStats() {
  const index = await getPineconeIndex()
  const stats = await index.describeIndexStats()
  return stats
}

module.exports = {
  createEmbedding,
  createQueryEmbedding,
  upsertKnowledgeVectors,
  deleteVectors,
  searchSimilar,
  getIndexStats,
}
