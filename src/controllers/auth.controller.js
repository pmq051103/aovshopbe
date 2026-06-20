const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../config/prisma')
const { sendResetPasswordEmail } = require('../config/email')
const { createReferralOnRegister } = require('../services/affiliate.service')

const generateTokens = (userId, role) => {
  const accessToken = jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });
  const refreshToken = jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });
  return { accessToken, refreshToken };
};

const register = async (req, res) => {
  try {
    const { username, email, password, displayName, refCode } = req.body;

    const exists = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
    if (exists) {
      return res.status(409).json({ success: false, message: exists.email === email ? 'Email đã được sử dụng' : 'Username đã tồn tại' });
    }

    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const user = await prisma.user.create({
      data: {
        username, email, password: hashedPassword,
        displayName: displayName || username,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        verifyToken: uuidv4()
      },
      select: { id: true, username: true, email: true, displayName: true, avatar: true, role: true, balance: true }
    });

    // Ghi nhận giới thiệu (CTV) nếu đăng ký bằng link giới thiệu — không chặn đăng ký nếu refCode lỗi
    if (refCode) {
      await createReferralOnRegister(refCode, user.id);
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken } });

    res.status(201).json({ success: true, message: 'Đăng ký thành công', data: { user, accessToken, refreshToken } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi đăng ký', error: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
 
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không đúng' });
    }
    if (user.isBanned) return res.status(403).json({ success: false, message: `Tài khoản bị khóa: ${user.banReason}` });
    if (!user.isActive) return res.status(401).json({ success: false, message: 'Tài khoản không hoạt động' });
 
    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken, lastLogin: new Date(), loginCount: { increment: 1 } } });
 
    const userData = { id: user.id, username: user.username, email: user.email, displayName: user.displayName, avatar: user.avatar, role: user.role, balance: user.balance, quanHuyBalance: user.quanHuyBalance, createdAt: user.createdAt, totalDeposit: user.totalDeposit, totalSpent: user.totalSpent };
    res.json({ success: true, message: 'Đăng nhập thành công', data: { user: userData, accessToken, refreshToken } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi đăng nhập' });
  }
};

const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) return res.status(401).json({ success: false, message: 'Không có refresh token' });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user || user.refreshToken !== token) {
      return res.status(401).json({ success: false, message: 'Refresh token không hợp lệ' });
    }

    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user.id, user.role);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken: newRefreshToken } });

    res.json({ success: true, data: { accessToken, refreshToken: newRefreshToken } });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });
  }
};

const logout = async (req, res) => {
  try {
    await prisma.user.update({ where: { id: req.user.id }, data: { refreshToken: null } });
    res.json({ success: true, message: 'Đăng xuất thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi đăng xuất' });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, username: true, email: true, displayName: true, avatar: true, role: true, balance: true, totalDeposit: true, totalSpent: true, createdAt: true, lastLogin: true, emailVerified: true, quanHuyBalance: true}
    });
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi lấy thông tin' });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      return res.json({
        success: true,
        message: 'Nếu email tồn tại, bạn sẽ nhận được link đặt lại mật khẩu',
      })
    }

    const resetToken = uuidv4()
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000)

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken,
        resetTokenExpiry,
      },
    })

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`

    const sent = await sendResetPasswordEmail({
      user,
      resetUrl,
    })

    if (!sent) {
      return res.status(500).json({
        success: false,
        message: 'Không gửi được email đặt lại mật khẩu',
      })
    }

    res.json({
      success: true,
      message: 'Link đặt lại mật khẩu đã được gửi',
    })
  } catch (error) {
    console.log('Forgot password error:', error)

    res.status(500).json({
      success: false,
      message: 'Lỗi gửi email',
      error: error.message,
    })
  }
}

const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = await prisma.user.findFirst({
      where: { resetToken: token, resetTokenExpiry: { gt: new Date() } }
    });

    if (!user) return res.status(400).json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn' });

    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({ where: { id: user.id }, data: { password: hashedPassword, resetToken: null, resetTokenExpiry: null, refreshToken: null } });

    res.json({ success: true, message: 'Đặt lại mật khẩu thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi đặt lại mật khẩu' });
  }
};

module.exports = { register, login, refreshToken, logout, getMe, forgotPassword, resetPassword };
