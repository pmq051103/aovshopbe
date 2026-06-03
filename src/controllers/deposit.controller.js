const PayOS = require('@payos/node');
const { emitToUser, emitToAdmins } = require('../config/socket');
const prisma = require('../config/prisma')

const payos = new PayOS(
  process.env.PAYOS_CLIENT_ID,
  process.env.PAYOS_API_KEY,
  process.env.PAYOS_CHECKSUM_KEY
);

// orderCode phải là số nguyên dương, tối đa 9007199254740991
// Dùng timestamp 10 chữ số + 3 random => luôn unique
const genOrderCode = () => {
  const ts = Math.floor(Date.now() / 1000); // unix timestamp (10 chữ số)
  const rand = Math.floor(Math.random() * 999) + 1;
  return parseInt(`${ts}${rand.toString().padStart(3, '0')}`);
};

const createDeposit = async (req, res) => {
  try {
    const { amount } = req.body;
    const minDeposit = 10000, maxDeposit = 50000000;

    if (!amount || amount < minDeposit)
      return res.status(400).json({ success: false, message: `Nạp tối thiểu ${minDeposit.toLocaleString()}đ` });
    if (amount > maxDeposit)
      return res.status(400).json({ success: false, message: `Nạp tối đa ${maxDeposit.toLocaleString()}đ` });

    const orderCode = genOrderCode();

    // Description tối đa 25 ký tự — PayOS sẽ reject nếu dài hơn
    const shortId = req.user.id.substring(0, 4).toUpperCase();
    const description = `NAP${shortId}${Date.now().toString().slice(-4)}`;

    const expiredAt = new Date(Date.now() + 30 * 60 * 1000);
    const cancelUrl = `${process.env.FRONTEND_URL}/deposit?status=cancel`;
    const returnUrl = `${process.env.FRONTEND_URL}/deposit?status=success`;

    console.log('[PayOS] Creating payment link, orderCode:', orderCode, 'description:', description);

    const payosResponse = await payos.createPaymentLink({
      orderCode,
      amount: Math.round(amount),
      description,
      cancelUrl,
      returnUrl,
      expiredAt: Math.floor(expiredAt.getTime() / 1000),
    });

    console.log('[PayOS] Payment link created:', {
      orderCode: payosResponse.orderCode,
      paymentLinkId: payosResponse.paymentLinkId,
      qrCodeLength: payosResponse.qrCode?.length,
      accountNumber: payosResponse.accountNumber,
    });

    // Lưu orderCode vào transferContent để dễ query sau (MySQL không hỗ trợ JSON path filter)
    // Format: "PAYOS_{orderCode}" — webhook sẽ tìm theo pattern này
    const transferContent = `PAYOS_${orderCode}`;

    const deposit = await prisma.deposit.create({
      data: {
        userId: req.user.id,
        amount,
        bankCode: 'PAYOS',
        accountNumber: payosResponse.accountNumber || '',
        accountName: payosResponse.accountName || '',
        transferContent, // "PAYOS_{orderCode}" — dùng để lookup trong webhook
        qrCodeUrl: payosResponse.qrCode || '',
        expiredAt,
        webhookData: {
          orderCode: String(orderCode),
          description,
          paymentLinkId: payosResponse.paymentLinkId || '',
          checkoutUrl: payosResponse.checkoutUrl || '',
          bin: payosResponse.bin || '',
        }
      }
    });

    emitToAdmins('admin:new_deposit', { userId: req.user.id, amount });

    res.status(201).json({
      success: true,
      message: 'Tạo lệnh nạp tiền thành công',
      data: {
        ...deposit,
        // Trả thêm các field FE cần
        qrCode: payosResponse.qrCode,       // EMV QR string — FE render bằng qrcode lib
        checkoutUrl: payosResponse.checkoutUrl,
        accountNumber: payosResponse.accountNumber,
        accountName: payosResponse.accountName,
        bin: payosResponse.bin,
        orderCode: String(orderCode),
        description,
      }
    });
  } catch (error) {
    console.error('[PayOS] createDeposit error:', error?.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Lỗi tạo lệnh nạp tiền: ' + (error?.response?.data?.desc || error.message || 'unknown error')
    });
  }
};

const getDepositHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const [deposits, total] = await Promise.all([
      prisma.deposit.findMany({
        where: { userId: req.user.id },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.deposit.count({ where: { userId: req.user.id } })
    ]);
    res.json({ success: true, data: deposits, pagination: { page: parseInt(page), total } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Lỗi lấy lịch sử nạp tiền' });
  }
};

// ============================================================
// WEBHOOK từ PayOS — tự động cộng tiền khi thanh toán thành công
// PayOS gọi POST đến endpoint này sau mỗi giao dịch
// ============================================================
const webhook = async (req, res) => {
  // Log mọi request vào webhook để debug
  console.log('[PayOS Webhook] Received:', JSON.stringify(req.body).substring(0, 200));

  try {
    // Bước 1: Xác thực chữ ký HMAC từ PayOS
    let webhookData;
    try {
      webhookData = payos.verifyPaymentWebhookData(req.body);
      console.log('[PayOS Webhook] Signature OK, data:', JSON.stringify(webhookData).substring(0, 200));
    } catch (verifyError) {
      console.error('[PayOS Webhook] Signature FAILED:', verifyError.message);
      console.error('[PayOS Webhook] Raw body:', JSON.stringify(req.body));
      // Trả 200 ngay cả khi verify fail để PayOS không retry liên tục
      return res.json({ success: false, message: 'Invalid signature' });
    }

    const { orderCode, code } = webhookData;
    console.log('[PayOS Webhook] orderCode:', orderCode, 'code:', code);

    // Bước 2: Tìm deposit — query bằng transferContent = "PAYOS_{orderCode}"
    const transferContent = `PAYOS_${orderCode}`;
    const deposit = await prisma.deposit.findFirst({
      where: { transferContent, status: 'PENDING' },
      include: { user: true }
    });

    if (!deposit) {
      console.warn('[PayOS Webhook] Deposit not found for transferContent:', transferContent);
      return res.json({ success: true, message: 'Deposit not found or already processed' });
    }

    console.log('[PayOS Webhook] Found deposit:', deposit.id, 'amount:', deposit.amount.toString());

    // Bước 3: Nếu thanh toán thất bại, cập nhật FAILED
    if (code !== '00') {
      console.log('[PayOS Webhook] Payment failed, code:', code);
      await prisma.deposit.update({
        where: { id: deposit.id },
        data: { status: 'FAILED' }
      });
      emitToAdmins('admin:deposit_update', { depositId: deposit.id, userId: deposit.userId, amount: deposit.amount, status: 'FAILED' });
      return res.json({ success: true, message: 'Payment failed' });
    }

    // Bước 4: Kiểm tra hết hạn
    if (new Date() > deposit.expiredAt) {
      console.warn('[PayOS Webhook] Deposit expired:', deposit.id);
      await prisma.deposit.update({ where: { id: deposit.id }, data: { status: 'EXPIRED' } });
      emitToAdmins('admin:deposit_update', { depositId: deposit.id, userId: deposit.userId, amount: deposit.amount, status: 'EXPIRED' });
      return res.json({ success: true, message: 'Deposit expired' });
    }

    // Bước 5: Cộng tiền vào tài khoản user (atomic transaction)
    console.log('[PayOS Webhook] Processing deposit for user:', deposit.userId);
    await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: deposit.userId },
        data: {
          balance: { increment: deposit.amount },
          totalDeposit: { increment: deposit.amount }
        }
      });

      await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        }
      });

      await tx.transaction.create({
        data: {
          userId: deposit.userId,
          type: 'DEPOSIT',
          status: 'COMPLETED',
          amount: deposit.amount,
          balanceBefore: deposit.user.balance,
          balanceAfter: updatedUser.balance,
          description: 'Nạp tiền qua PayOS',
          depositId: deposit.id
        }
      });

      await tx.notification.create({
        data: {
          userId: deposit.userId,
          type: 'DEPOSIT',
          title: '💰 Nạp tiền thành công!',
          message: `Tài khoản đã được cộng ${parseInt(deposit.amount).toLocaleString('vi-VN')}đ`,
          data: { depositId: deposit.id, amount: deposit.amount }
        }
      });

      // Cập nhật bảng xếp hạng
      const now = new Date();
      const periods = [
        { period: 'daily',   key: `daily_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}` },
        { period: 'weekly',  key: `weekly_${now.getFullYear()}_${getWeek(now)}` },
        { period: 'monthly', key: `monthly_${now.getFullYear()}_${now.getMonth() + 1}` }
      ];
      for (const p of periods) {
        await tx.ranking.upsert({
          where: { userId_periodKey: { userId: deposit.userId, periodKey: p.key } },
          create: { userId: deposit.userId, period: p.period, periodKey: p.key, totalDeposit: deposit.amount, totalSpent: 0 },
          update: { totalDeposit: { increment: deposit.amount } }
        });
      }
    });

    console.log('[PayOS Webhook] ✅ Deposit completed:', deposit.id, 'user:', deposit.userId);

    // Bước 6: Thông báo real-time qua Socket.IO
    emitToUser(deposit.userId, 'deposit:success', {
      amount: deposit.amount,
      message: `Nạp tiền thành công: ${parseInt(deposit.amount).toLocaleString('vi-VN')}đ`
    });
    emitToUser(deposit.userId, 'balance:update', {});
    emitToAdmins('admin:deposit_update', { depositId: deposit.id, userId: deposit.userId, amount: deposit.amount, status: 'COMPLETED' });

    res.json({ success: true, message: 'Deposit processed successfully' });
  } catch (error) {
    console.error('[PayOS Webhook] Error:', error);
    // Vẫn trả 200 để PayOS không retry
    res.json({ success: false, message: 'Internal error' });
  }
};

// Admin xác nhận thủ công
const confirmDeposit = async (req, res) => {
  try {
    const deposit = await prisma.deposit.findUnique({
      where: { id: req.params.id },
      include: { user: true }
    });
    if (!deposit) return res.status(404).json({ success: false, message: 'Không tìm thấy' });
    if (deposit.status !== 'PENDING') return res.status(400).json({ success: false, message: 'Lệnh đã được xử lý' });

    await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: deposit.userId },
        data: { balance: { increment: deposit.amount }, totalDeposit: { increment: deposit.amount } }
      });
      await tx.deposit.update({ where: { id: deposit.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await tx.transaction.create({
        data: {
          userId: deposit.userId, type: 'DEPOSIT', status: 'COMPLETED',
          amount: deposit.amount, balanceBefore: deposit.user.balance, balanceAfter: updatedUser.balance,
          description: 'Nạp tiền thủ công bởi admin', depositId: deposit.id
        }
      });
      await tx.notification.create({
        data: {
          userId: deposit.userId, type: 'DEPOSIT', title: '💰 Nạp tiền thành công!',
          message: `Tài khoản đã được cộng ${parseInt(deposit.amount).toLocaleString('vi-VN')}đ`,
          data: { depositId: deposit.id, amount: deposit.amount }
        }
      });
      const now = new Date();
      const periods = [
        { period: 'daily',   key: `daily_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}` },
        { period: 'weekly',  key: `weekly_${now.getFullYear()}_${getWeek(now)}` },
        { period: 'monthly', key: `monthly_${now.getFullYear()}_${now.getMonth() + 1}` }
      ];
      for (const p of periods) {
        await tx.ranking.upsert({
          where: { userId_periodKey: { userId: deposit.userId, periodKey: p.key } },
          create: { userId: deposit.userId, period: p.period, periodKey: p.key, totalDeposit: deposit.amount, totalSpent: 0 },
          update: { totalDeposit: { increment: deposit.amount } }
        });
      }
    });

    emitToUser(deposit.userId, 'deposit:success', { amount: deposit.amount });
    emitToUser(deposit.userId, 'balance:update', {});
    res.json({ success: true, message: 'Xác nhận nạp tiền thành công' });
  } catch (error) {
    console.error('confirmDeposit error:', error);
    res.status(500).json({ success: false, message: 'Lỗi xác nhận' });
  }
};

const getWeek = (date) => {
  const onejan = new Date(date.getFullYear(), 0, 1);
  return Math.ceil((((date - onejan) / 86400000) + onejan.getDay() + 1) / 7);
};

module.exports = { createDeposit, getDepositHistory, webhook, confirmDeposit };