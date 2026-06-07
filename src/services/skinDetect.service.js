/**
 * skinDetect.service.js
 * ─────────────────────────────────────────────────────────────────────────
 * AI Skin Detection — Gemini Vision + MySQL fuzzy match
 *
 * Flow:
 *  1. Gemini Vision phân tích ảnh → trả về list tên skin nhìn thấy
 *  2. Normalize tên (lowercase, bỏ dấu, trim)
 *  3. Match với SkinTemplate trong MySQL (skinName + aliases)
 *  4. Trả về kết quả với confidence score
 */

const prisma = require('../config/prisma')
const logger = require('../config/logger')

const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash-lite'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

function normalize(str) {
  if (!str) return ''

  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarityScore(a, b) {
  const tokensA = new Set(normalize(a).split(' ').filter(Boolean))
  const tokensB = new Set(normalize(b).split(' ').filter(Boolean))

  if (!tokensA.size || !tokensB.size) return 0

  let overlap = 0

  tokensA.forEach(t => {
    if (tokensB.has(t)) overlap++
  })

  const union = new Set([...tokensA, ...tokensB]).size
  return overlap / union
}

function safeJsonParse(text, fallback) {
  try {
    if (!text) return fallback

    const cleaned = String(text)
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim()

    return JSON.parse(cleaned)
  } catch {
    return fallback
  }
}

function findBestMatch(geminiName, templates) {
  const normQuery = normalize(geminiName)
  if (!normQuery) return null

  let best = null
  let bestScore = 0

  for (const tpl of templates) {
    const scoreMain = similarityScore(normQuery, tpl.skinName)

    let scoreAlias = 0

    if (tpl.aliases) {
      const aliasList = tpl.aliases
        .split(',')
        .map(a => a.trim())
        .filter(Boolean)

      for (const alias of aliasList) {
        const s = similarityScore(normQuery, alias)
        if (s > scoreAlias) scoreAlias = s
      }
    }

    const scoreHero = similarityScore(normQuery, tpl.heroName) * 0.3
    const baseScore = Math.max(scoreMain, scoreAlias)

const geminiHero = normalize(geminiName)
const tplHero = normalize(tpl.heroName)

// Nếu Gemini trả tên không chứa tên tướng, không cộng hero bonus
const finalScore = baseScore

    if (finalScore > bestScore) {
      bestScore = finalScore
      best = tpl
    }
  }

  if (bestScore < 0.50) return null

  return {
    template: best,
    score: Math.min(bestScore, 1),
  }
}

async function imageUrlToBase64(imageUrl) {
  const imgRes = await fetch(imageUrl)

  if (!imgRes.ok) {
    throw new Error(`Không fetch được ảnh: ${imgRes.status}`)
  }

  const contentLength = Number(imgRes.headers.get('content-length') || 0)

  if (contentLength > 8 * 1024 * 1024) {
    throw new Error('Ảnh quá lớn, vui lòng dùng ảnh dưới 8MB')
  }

  const buffer = await imgRes.arrayBuffer()
  const base64 = Buffer.from(buffer).toString('base64')
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'

  return { base64, mimeType }
}

async function generateGeminiJson({ imageUrl, prompt, maxOutputTokens = 2048 }) {
  const apiKey = process.env.GEMINI_API_KEY

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY chưa được cấu hình')
  }

  const { base64, mimeType } = await imageUrlToBase64(imageUrl)

  const res = await fetch(
    `${GEMINI_BASE}/models/${VISION_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType,
                  data: base64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens,
          responseMimeType: 'application/json',
        },
      }),
    }
  )

  if (res.status === 429) {
    logger.warn(`[SkinDetect] Gemini quota exceeded: model=${VISION_MODEL}`)
    return null
  }

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini Vision lỗi ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function callGeminiVision(imageUrl) {
const prompt = `Bạn là chuyên gia nhận diện skin Liên Quân Mobile (Arena of Valor).

Ảnh này có thể là ảnh tổng hợp rất nhiều skin của một tài khoản. 
Tên skin trong ảnh có thể nhỏ, mờ hoặc không đọc rõ.

Nhiệm vụ:
- Chỉ nhận diện các skin/trang phục mà bạn nhìn thấy rõ.
- Ưu tiên các skin nổi bật, skin hiếm, skin SS, SSS, collab/anime, skin ở hàng đầu hoặc skin có chữ dễ đọc.
- KHÔNG cần liệt kê tất cả skin trong ảnh.
- KHÔNG đoán bừa nếu không nhìn rõ.
- Nếu chỉ thấy tên tướng nhưng không chắc tên skin thì bỏ qua.
- Nếu nhìn được một phần tên skin, hãy trả về tên gần đúng và confidence thấp hơn.

Trả về JSON array đúng format sau, KHÔNG thêm text ngoài JSON:

[
  {
    "skinName": "Tên skin bạn nhìn thấy hoặc tên gần đúng",
    "heroName": "Tên tướng sở hữu skin nếu nhìn thấy",
    "confidence": 0.75
  }
]

Quy tắc confidence:
- 0.9 - 1.0: nhìn rõ tên skin
- 0.7 - 0.89: nhận diện khá chắc qua hình ảnh hoặc chữ
- 0.4 - 0.69: chỉ nhìn được một phần, có thể sai
- Dưới 0.4 thì không trả về

Nếu không nhận diện được skin nào, trả về [].
Chỉ trả về JSON array.`

  const text = await generateGeminiJson({
    imageUrl,
    prompt,
    maxOutputTokens: 4096,
  })

  if (!text) return []

  const parsed = safeJsonParse(text, [])

  return Array.isArray(parsed) ? parsed : []
}

async function detectSkinsFromImage(imageUrl) {
  logger.info(`[SkinDetect] Bắt đầu detect bằng ${VISION_MODEL}: ${imageUrl.slice(0, 80)}...`)

  const visionResults = await callGeminiVision(imageUrl)

  logger.info(`[SkinDetect] Gemini nhận diện: ${visionResults.length} skin`)

  if (!visionResults.length) return []

  const templates = await prisma.skinTemplate.findMany({
    where: { isActive: true },
    select: {
      id: true,
      skinName: true,
      heroName: true,
      rarity: true,
      aliases: true,
      imageUrl: true,
    },
  })

  const results = []
  const seenTemplateIds = new Set()

  for (const item of visionResults) {
    if (!item?.skinName) continue

    const match = findBestMatch(item.skinName, templates)
    const aiConfidence = Number(item.confidence || 0.5)

    if (match && !seenTemplateIds.has(match.template.id)) {
      seenTemplateIds.add(match.template.id)

      results.push({
        skinName: match.template.skinName,
        heroName: match.template.heroName,
        rarity: match.template.rarity,
       confidence: (() => {
  const aiConf = Number(item.confidence || 0.5)
  const matchScore = Number(match.score || 0)

  // Nếu match tên rất tốt thì ưu tiên matchScore, đừng nhân làm tụt %
  if (matchScore >= 0.9) return 1.0
  if (matchScore >= 0.8) return 0.95
  if (matchScore >= 0.7) return 0.85

  return Math.round(Math.min(aiConf * matchScore, 0.75) * 100) / 100
})(),
        templateId: match.template.id,
        isMatched: true,
        source: 'AI_VISION',
        imageUrl: match.template.imageUrl,
      })
    } else if (!match) {
      results.push({
        skinName: item.skinName,
        heroName: item.heroName || '',
        rarity: 'COMMON',
        confidence: Math.round(Math.min(aiConfidence * 0.75, 1) * 100) / 100,
        templateId: null,
        isMatched: false,
        source: 'AI_VISION',
        imageUrl: null,
      })
    }
  }

  results.sort((a, b) => {
    if (a.isMatched !== b.isMatched) return a.isMatched ? -1 : 1
    return b.confidence - a.confidence
  })

  logger.info(
    `[SkinDetect] Kết quả: ${results.length} skin (${results.filter(r => r.isMatched).length} matched DB)`
  )

  return results
}

async function verifySkinImage(imageUrl, expectedSkinName) {
  const prompt = `Ảnh này có phải là skin "${expectedSkinName}" trong game Liên Quân Mobile không?

Trả về JSON object đúng format sau:

{
  "isMatch": true,
  "confidence": 0.9,
  "detectedSkin": "tên skin bạn nhìn thấy"
}

Quy tắc:
- Chỉ trả về JSON object.
- Nếu không chắc, isMatch=false và confidence thấp.
- detectedSkin là tên skin bạn nhìn thấy trong ảnh.`

  try {
    const text = await generateGeminiJson({
      imageUrl,
      prompt,
      maxOutputTokens: 512,
    })

    if (!text) {
      return {
        isMatch: true,
        confidence: 0.6,
        detectedSkin: expectedSkinName,
        skipped: true,
        reason: 'Gemini quota exceeded hoặc không có response',
      }
    }

    const parsed = safeJsonParse(text, null)

    if (!parsed || typeof parsed !== 'object') {
      return {
        isMatch: true,
        confidence: 0.6,
        detectedSkin: expectedSkinName,
        skipped: true,
        reason: 'Không parse được JSON',
      }
    }

    return {
      isMatch: Boolean(parsed.isMatch),
      confidence: Number(parsed.confidence || 0.5),
      detectedSkin: parsed.detectedSkin || expectedSkinName,
    }
  } catch (err) {
    logger.warn(`[SkinDetect.verifySkinImage] Bỏ qua verify ảnh: ${err.message}`)

    return {
      isMatch: true,
      confidence: 0.6,
      detectedSkin: expectedSkinName,
      skipped: true,
      reason: err.message,
    }
  }
}

module.exports = {
  detectSkinsFromImage,
  verifySkinImage,
  normalize,
}