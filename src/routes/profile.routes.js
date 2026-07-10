const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/authMiddleware')
const { getProfileOverview } = require('../controllers/profile.controller')

router.get('/overview', protect, getProfileOverview)

module.exports = router
