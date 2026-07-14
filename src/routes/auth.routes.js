// auth.routes.js  (UPDATED - thêm Google OAuth)
const express = require('express');
const router = express.Router();

const {
  register,
  login,
  refreshToken,
  logout,
  getMe,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerificationCode,
} = require('../controllers/auth.controller');

const { googleLogin } = require('../controllers/googleAuth.controller');

const { protect } = require('../middleware/authMiddleware');
const rateLimiter = require('../middleware/rateLimiter');

router.post('/register', rateLimiter.auth, register);
router.post('/login', rateLimiter.auth, login);
router.post('/refresh', refreshToken);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.post('/forgot-password', rateLimiter.auth, forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/google', rateLimiter.auth, googleLogin);
router.post('/verify-email', rateLimiter.auth, verifyEmail);
router.post('/resend-verification-code', rateLimiter.auth, resendVerificationCode);

module.exports = router;