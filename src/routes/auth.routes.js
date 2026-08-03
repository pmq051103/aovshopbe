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
const { registerRules, loginRules, handleValidationErrors } = require('../validators/validator');
const { verifyCsrfOrigin } = require('../middleware/csrf');

router.post('/register', rateLimiter.auth, registerRules, handleValidationErrors, register);
router.post('/login', rateLimiter.auth, loginRules, handleValidationErrors, login);
// refresh & logout dùng httpOnly cookie -> thêm kiểm tra Origin/Referer chống CSRF
router.post('/refresh', rateLimiter.auth, verifyCsrfOrigin, refreshToken);
router.post('/logout', verifyCsrfOrigin, protect, logout);
router.get('/me', protect, getMe);
router.post('/forgot-password', rateLimiter.auth, forgotPassword);
router.post('/reset-password', rateLimiter.auth, resetPassword);
router.post('/google', rateLimiter.auth, googleLogin);
router.post('/verify-email', rateLimiter.auth, verifyEmail);
router.post('/resend-verification-code', rateLimiter.auth, resendVerificationCode);

module.exports = router;