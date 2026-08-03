const { body, validationResult } = require('express-validator')

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      errors: errors.array()
    })
  }
  next()
}

// LƯU Ý: KHÔNG dùng normalizeEmail() — nó hạ chữ thường + bỏ dấu chấm (gmail) làm lệch
// so với email đã lưu trong DB (đăng ký trước đây không chuẩn hoá) => hỏng đăng nhập.
// Chỉ validate ĐỊNH DẠNG, không biến đổi giá trị.
const registerRules = [
  body('username').trim().isLength({ min: 4, max: 20 }).withMessage('Username phải từ 4-20 ký tự').matches(/^[a-zA-Z0-9_]+$/).withMessage('Username chỉ chứa chữ, số, gạch dưới'),
  body('email').isEmail().withMessage('Email không hợp lệ'),
  body('password').isLength({ min: 8, max: 100 }).withMessage('Mật khẩu tối thiểu 8 ký tự'),
  body('displayName').optional().trim().isLength({ max: 50 }).withMessage('Tên hiển thị tối đa 50 ký tự'),
]

const loginRules = [
  body('email').isEmail().withMessage('Email không hợp lệ'),
  body('password').notEmpty().withMessage('Vui lòng nhập mật khẩu'),
]

const depositRules = [
  body('amount').isFloat({ min: 10000, max: 50000000 }).withMessage('Số tiền nạp từ 10,000 đến 50,000,000 VNĐ'),
]

module.exports = {
  handleValidationErrors,
  registerRules,
  loginRules,
  depositRules,
}