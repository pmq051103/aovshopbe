// googleAuth.controller.js (FINAL VERSION)
// Nhận access_token từ FE (@react-oauth/google useGoogleLogin),
// verify bằng Google userinfo endpoint, rồi tạo/tìm user và trả JWT.

const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { id: userId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { accessToken, refreshToken };
};

/**
 * POST /api/auth/google
 * Body: { credential: <Google access_token từ useGoogleLogin FE> }
 */
const googleLogin = async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, message: 'Thiếu Google credential' });
    }

    // Verify access_token bằng cách gọi Google userinfo endpoint
    let googleUser;
    try {
      const response = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${credential}` },
      });
      googleUser = response.data;
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Google token không hợp lệ' });
    }

    const { sub: googleId, email, name, picture } = googleUser;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Không lấy được email từ Google' });
    }

    // Tìm user theo googleId hoặc email
    let user = await prisma.user.findFirst({
      where: {
        OR: [{ googleId }, { email }],
      },
    });

    if (user) {
      if (user.isBanned) {
        return res.status(403).json({
          success: false,
          message: `Tài khoản bị khóa: ${user.banReason}`,
        });
      }
      if (!user.isActive) {
        return res.status(401).json({ success: false, message: 'Tài khoản không hoạt động' });
      }

      // Liên kết googleId nếu user đã đăng ký trước bằng email
      if (!user.googleId) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId,
            avatar: user.avatar?.includes('dicebear') ? picture : user.avatar,
            emailVerified: true,
          },
        });
      }
    } else {
      // Tạo user mới từ Google
      const baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
      let username = baseUsername;
      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing) {
        username = `${baseUsername}_${Math.floor(Math.random() * 9999)}`;
      }

      const randomPassword = await bcrypt.hash(uuidv4(), 10);
      user = await prisma.user.create({
        data: {
          username,
          email,
          password: randomPassword,
          displayName: name || username,
          avatar: picture || `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
          googleId,
          emailVerified: true,
          verifyToken: null,
        },
      });
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        refreshToken,
        lastLogin: new Date(),
        loginCount: { increment: 1 },
      },
    });

    res.json({
      success: true,
      message: 'Đăng nhập Google thành công',
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          avatar: user.avatar,
          role: user.role,
          balance: user.balance,
          quanHuyBalance: user.quanHuyBalance,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({
      success: false,
      message: 'Lỗi đăng nhập Google',
      error: error.message,
    });
  }
};

module.exports = { googleLogin };