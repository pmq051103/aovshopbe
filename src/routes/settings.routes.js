const express = require('express')
const router = express.Router()
const ctrl = require('../controllers/settings.controller')
const { protect, adminOnly } = require('../middleware/authMiddleware')
const { uploadSettings } = require('../config/cloudinary')

router.get('/public', ctrl.getPublic)
router.get('/', protect, adminOnly, ctrl.getAll)

router.post(
  '/bulk',
  protect,
  adminOnly,
  uploadSettings.fields([
    { name: 'site_logo', maxCount: 1 },
    { name: 'site_favicon', maxCount: 1 }
  ]),
  ctrl.upsertMany
)

router.post('/', protect, adminOnly, ctrl.upsertOne)

module.exports = router