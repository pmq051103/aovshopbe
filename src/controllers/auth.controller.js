const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../config/prisma')
const { sendResetPasswordEmail, sendVerificationCodeEmail } = require('../config/email')
const { createReferralOnRegister } = require('../services/affiliate.service')

// Sinh mã xác thực 6 chữ số (OTP)
const generateVerifyCode = () => String(Math.floor(100000 + Math.random() * 900000))

// ── Admin bật/tắt yêu cầu xác thực email khi đăng ký (SiteConfig, key: require_email_verification) ──
// Mặc định TẮT nếu admin chưa từng cấu hình — tránh việc mới thêm tính năng
// mà tự động bắt buộc xác thực ngay khi chưa ai bật trong trang Cài đặt.
const isEmailVerificationRequired = async () => {
  const config = await prisma.siteConfig.findUnique({ where: { key: 'require_email_verification' } })
  return config?.value === 'true'
}

// ── Sinh mã mới, lưu DB và gửi email — dùng chung cho register / login / resend ──
// Tôn trọng cooldown 60s chống spam gửi mail (trừ khi force=true, dùng lúc đăng ký
// vì đó là lần gửi đầu tiên, chưa có mã cũ nào để giữ).
const VERIFY_COOLDOWN_MS = 60 * 1000
const VERIFY_CODE_TTL_MS = 10 * 60 * 1000

const issueVerificationCode = async (user, { force = false } = {}) => {
  if (!force && user.verifyCodeSentAt && Date.now() - user.verifyCodeSentAt.getTime() < VERIFY_COOLDOWN_MS) {
    const waitSec = Math.ceil((VERIFY_COOLDOWN_MS - (Date.now() - user.verifyCodeSentAt.getTime())) / 1000)
    return { sent: false, waitSec }
  }

  const verifyCode = generateVerifyCode()
  const verifyCodeExpiry = new Date(Date.now() + VERIFY_CODE_TTL_MS)

  await prisma.user.update({
    where: { id: user.id },
    data: { verifyCode, verifyCodeExpiry, verifyCodeSentAt: new Date() },
  })

  // Không chặn luồng chính nếu gửi mail lỗi — user vẫn bấm "Gửi lại mã" được
  sendVerificationCodeEmail({ user, code: verifyCode }).catch(e =>
    console.error('[Email verify-code] error:', e.message)
  )

  return { sent: true, waitSec: 0 }
}

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
    const verificationRequired = await isEmailVerificationRequired()

    const user = await prisma.user.create({
      data: {
        username, email, password: hashedPassword,
        displayName: displayName || username,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        verifyToken: uuidv4(),
        // Admin không bật yêu cầu xác thực -> coi như đã xác thực ngay, khỏi chặn/nhắc user
        emailVerified: !verificationRequired,
      },
      select: { id: true, username: true, email: true, displayName: true, avatar: true, role: true, balance: true, emailVerified: true, verifyCodeSentAt: true }
    });

    // Ghi nhận giới thiệu (CTV) nếu đăng ký bằng link giới thiệu — không chặn đăng ký nếu refCode lỗi
    if (refCode) {
      await createReferralOnRegister(refCode, user.id);
    }

    const { accessToken, refreshToken } = generateTokens(user.id, user.role);
    await prisma.user.update({ where: { id: user.id }, data: { refreshToken } });

    // Gửi email mã xác thực — chỉ khi admin đã bật tính năng này trong Cài đặt.
    // force:true vì đây là lần gửi đầu tiên, chưa có mã cũ nào để giữ cooldown.
    if (verificationRequired) {
      await issueVerificationCode(user, { force: true })
    }

    res.status(201).json({
      success: true,
      message: verificationRequired ? 'Đăng ký thành công, vui lòng kiểm tra email để lấy mã xác thực' : 'Đăng ký thành công',
      data: { user, accessToken, refreshToken },
    });
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

    // Chỉ bắt xác thực khi ĐỒNG THỜI: (1) admin đang bật yêu cầu này trong Cài đặt
    // VÀ (2) tài khoản chưa verify. Nếu admin đã TẮT tính năng sau khi user đăng ký lúc
    // còn bật (nên emailVerified=false), user vẫn đăng nhập bình thường, không bị chặn.
    // Vẫn cho đăng nhập trong lúc cần xác thực (để FE có sẵn user/token gọi API
    // verify-email) nhưng tự gửi mã mới, tôn trọng cooldown 60s chống spam.
    let needsVerification = false
    if (!user.emailVerified) {
      const verificationRequired = await isEmailVerificationRequired()
      if (verificationRequired) {
        needsVerification = true
        await issueVerificationCode(user)
      }
    }

    const userData = { id: user.id, username: user.username, email: user.email, displayName: user.displayName, avatar: user.avatar, role: user.role, balance: user.balance, quanHuyBalance: user.quanHuyBalance, createdAt: user.createdAt, totalDeposit: user.totalDeposit, totalSpent: user.totalSpent, emailVerified: user.emailVerified };
    res.json({ success: true, message: 'Đăng nhập thành công', data: { user: userData, accessToken, refreshToken, needsVerification } });
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

// Xác thực email bằng mã OTP đã gửi lúc đăng ký
const verifyEmail = async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Thiếu email hoặc mã xác thực' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ success: false, message: 'Tài khoản không tồn tại' });

    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email đã được xác thực trước đó' });
    }

    if (!user.verifyCode || !user.verifyCodeExpiry || user.verifyCodeExpiry < new Date()) {
      return res.status(400).json({ success: false, message: 'Mã xác thực đã hết hạn, vui lòng bấm gửi lại mã' });
    }

    if (user.verifyCode !== code) {
      return res.status(400).json({ success: false, message: 'Mã xác thực không đúng' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verifyCode: null, verifyCodeExpiry: null, verifyToken: null },
    });

    res.json({ success: true, message: 'Xác thực email thành công' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi xác thực email' });
  }
};

// Gửi lại mã xác thực — giới hạn 60s / lần để chống spam gửi mail
const resendVerificationCode = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Thiếu email' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ success: false, message: 'Tài khoản không tồn tại' });

    if (user.emailVerified) {
      return res.json({ success: true, message: 'Email đã được xác thực trước đó' });
    }

    if (user.verifyCodeSentAt && Date.now() - user.verifyCodeSentAt.getTime() < 60 * 1000) {
      const waitSec = 60 - Math.floor((Date.now() - user.verifyCodeSentAt.getTime()) / 1000);
      return res.status(429).json({ success: false, message: `Vui lòng đợi ${waitSec}s trước khi gửi lại mã` });
    }

    const { sent, waitSec } = await issueVerificationCode(user)
    if (!sent) {
      return res.status(429).json({ success: false, message: `Vui lòng đợi ${waitSec}s trước khi gửi lại mã` });
    }

    res.json({ success: true, message: 'Đã gửi lại mã xác thực' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi gửi lại mã xác thực' });
  }
};

module.exports = { register, login, refreshToken, logout, getMe, forgotPassword, resetPassword, verifyEmail, resendVerificationCode };