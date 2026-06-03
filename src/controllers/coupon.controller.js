const prisma = require('../config/prisma')

const formatCouponData = (body, isUpdate = false) => {
  const data = {}

  if (body.code !== undefined) data.code = body.code.toUpperCase()
  if (body.name !== undefined) data.name = body.name
  if (body.type !== undefined) data.type = body.type
  if (body.description !== undefined) data.description = body.description

  if (body.value !== undefined) data.value = parseFloat(body.value || 0)
  if (body.minPurchase !== undefined) data.minPurchase = parseFloat(body.minPurchase || 0)
  if (body.maxDiscount !== undefined) {
    data.maxDiscount = body.maxDiscount === '' || body.maxDiscount === null
      ? null
      : parseFloat(body.maxDiscount)
  }

  if (body.usageLimit !== undefined) data.usageLimit = parseInt(body.usageLimit || 1)
  if (body.perUserLimit !== undefined) data.perUserLimit = parseInt(body.perUserLimit || 1)

  if (body.isActive !== undefined) {
    data.isActive = body.isActive === true || body.isActive === 'true'
  }

  if (body.startDate !== undefined) {
    data.startDate = body.startDate ? new Date(body.startDate) : null
  }

  if (body.endDate !== undefined) {
    data.endDate = body.endDate ? new Date(body.endDate) : null
  }

  return data
}

const validateCoupon = async (req, res) => {
  try {
    const { code, amount } = req.body

    if (!code) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập mã coupon'
      })
    }

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.toUpperCase() }
    })

    if (!coupon || !coupon.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Mã coupon không tồn tại hoặc đã hết hiệu lực'
      })
    }

    const now = new Date()

    if (coupon.startDate && now < coupon.startDate) {
      return res.status(400).json({
        success: false,
        message: 'Coupon chưa đến thời gian sử dụng'
      })
    }

    if (coupon.endDate && now > coupon.endDate) {
      return res.status(400).json({
        success: false,
        message: 'Coupon đã hết hạn'
      })
    }

    if (coupon.usageCount >= coupon.usageLimit) {
      return res.status(400).json({
        success: false,
        message: 'Coupon đã hết lượt sử dụng'
      })
    }

    if (amount && parseFloat(amount) < parseFloat(coupon.minPurchase)) {
      return res.status(400).json({
        success: false,
        message: `Đơn hàng tối thiểu ${parseInt(coupon.minPurchase).toLocaleString('vi-VN')}đ để dùng coupon này`
      })
    }

    const userUsage = await prisma.couponUsage.count({
      where: {
        couponId: coupon.id,
        userId: req.user.id
      }
    })

    if (userUsage >= coupon.perUserLimit) {
      return res.status(400).json({
        success: false,
        message: 'Bạn đã dùng hết lượt cho coupon này'
      })
    }

    let discount = 0

    if (amount) {
      const orderAmount = parseFloat(amount)

      if (coupon.type === 'PERCENT') {
        discount = orderAmount * parseFloat(coupon.value) / 100

        if (coupon.maxDiscount) {
          discount = Math.min(discount, parseFloat(coupon.maxDiscount))
        }
      } else if (coupon.type === 'FIXED') {
        discount = Math.min(parseFloat(coupon.value), orderAmount)
      }
    }

    res.json({
      success: true,
      data: {
        ...coupon,
        estimatedDiscount: discount
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const adminGetCoupons = async (req, res) => {
  try {
    const { page = 1, limit = 10, search } = req.query

    const currentPage = parseInt(page)
    const pageSize = parseInt(limit)

    const where = search
      ? {
          OR: [
            { code: { contains: search } },
            { name: { contains: search } }
          ]
        }
      : {}

    const [coupons, total] = await Promise.all([
      prisma.coupon.findMany({
        where,
        skip: (currentPage - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.coupon.count({ where })
    ])

    res.json({
      success: true,
      data: coupons,
      pagination: {
        page: currentPage,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const adminCreateCoupon = async (req, res) => {
  try {
    const data = formatCouponData(req.body)

    const coupon = await prisma.coupon.create({
      data
    })

    res.status(201).json({
      success: true,
      data: coupon
    })
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'Mã coupon đã tồn tại'
      })
    }

    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const adminUpdateCoupon = async (req, res) => {
  try {
    const data = formatCouponData(req.body, true)

    const coupon = await prisma.coupon.update({
      where: { id: req.params.id },
      data
    })

    res.json({
      success: true,
      data: coupon
    })
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'Mã coupon đã tồn tại'
      })
    }

    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const adminDeleteCoupon = async (req, res) => {
  try {
    await prisma.coupon.delete({
      where: { id: req.params.id }
    })

    res.json({
      success: true,
      message: 'Đã xóa coupon'
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message
    })
  }
}

const getPublicCoupons = async (req, res) => {
  try {
    const now = new Date()

    const raw = await prisma.coupon.findMany({
      where: { isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        type: true,
        value: true,
        minPurchase: true,
        maxDiscount: true,
        usageLimit: true,
        usageCount: true,
        perUserLimit: true,
        isActive: true,
        startDate: true,
        endDate: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    })

    const coupons = raw.filter(c => {
      if (c.startDate && now < c.startDate) return false
      if (c.endDate && now > c.endDate) return false
      if (c.usageCount >= c.usageLimit) return false
      return true
    })

    res.json({ success: true, data: coupons })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
}

module.exports = {
  validateCoupon,
  adminGetCoupons,
  adminCreateCoupon,
  adminUpdateCoupon,
  adminDeleteCoupon,
  getPublicCoupons
}