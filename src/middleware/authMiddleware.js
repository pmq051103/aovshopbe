const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma')

const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, message: 'Không có token xác thực' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, username: true, email: true, role: true, isActive: true, isBanned: true, balance: true, displayName: true, avatar: true }
    });

    if (!user) return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
    if (!user.isActive) return res.status(401).json({ success: false, message: 'Tài khoản đã bị vô hiệu hóa' });
    if (user.isBanned) return res.status(403).json({ success: false, message: 'Tài khoản đã bị khóa' });

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token đã hết hạn', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Không có quyền truy cập' });
  }
  next();
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, username: true, email: true, role: true }
      });
      req.user = user;
    }
  } catch (e) {}
  next();
};

module.exports = { protect, adminOnly, optionalAuth };