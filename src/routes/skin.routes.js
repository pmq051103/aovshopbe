const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/skin.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')

router.get('/search', ctrl.searchSkins)
router.get('/top', ctrl.getTopSkins)
router.get('/account/:accountId', ctrl.getAccountSkins)
router.put('/account/:accountId', protect, adminOnly, ctrl.setAccountSkins)
router.post('/account/:accountId', protect, adminOnly, ctrl.addSkin)
router.delete('/:id', protect, adminOnly, ctrl.deleteSkin)

module.exports = router