const express = require('express')
const router  = express.Router()
const { protect } = require('../middleware/authMiddleware')
const sessionCtrl = require('../controllers/chatSession.controller')
const chatCtrl    = require('../controllers/chat.controller')

// Tất cả routes yêu cầu đăng nhập
router.use(protect)

// Session management
router.get   ('/sessions',          sessionCtrl.listSessions)
router.post  ('/session',           sessionCtrl.createSession)
router.get   ('/session/:id',       sessionCtrl.getSession)
router.delete('/session/:id',       sessionCtrl.deleteSession)
router.patch ('/session/:id/title', sessionCtrl.updateTitle)

// Gửi tin nhắn (main AI endpoint)
router.post('/message', chatCtrl.sendMessage)

module.exports = router
