const express = require('express')
const router  = express.Router()
const ctrl    = require('../controllers/aiKnowledge.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

// Tất cả routes đều yêu cầu admin
router.use(protect, adminOnly)

// CRUD
router.get   ('/',            ctrl.list)
router.get   ('/sync-status', ctrl.getSyncStatus)
router.get   ('/:id',         ctrl.getOne)
router.post  ('/',            ctrl.create)
router.put   ('/:id',         ctrl.update)
router.delete('/:id',         ctrl.remove)
router.patch ('/:id/toggle',  ctrl.toggleActive)

// Đồng bộ sang Pinecone — có thể mất nhiều thời gian với data lớn
router.post('/sync/all', ctrl.syncToVector)

module.exports = router
