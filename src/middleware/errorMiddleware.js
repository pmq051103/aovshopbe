const logger = require('../config/logger');

const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.status = 404;
  next(error);
};

const errorHandler = (err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;

  if (statusCode >= 500) {
    logger.error('Server Error:', { message: err.message, stack: err.stack, url: req.originalUrl });
  }

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({ success: false, message: 'Dữ liệu đã tồn tại', field: err.meta?.target });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu' });
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Lỗi máy chủ nội bộ',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = { notFound, errorHandler };