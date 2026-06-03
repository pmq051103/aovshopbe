const bcrypt = require('bcryptjs');

const prisma = require('../config/prisma')

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminPassword = await bcrypt.hash('Admin@123456', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@lienquanshop.vn' },
    update: {},
    create: {
      username: 'admin',
      email: 'admin@lienquanshop.vn',
      password: adminPassword,
      displayName: 'Administrator',
      role: 'ADMIN',
      emailVerified: true,
      balance: 999999,
      avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=admin'
    }
  });
  console.log('✅ Admin created:', admin.email);

  // Create test users
  const userPassword = await bcrypt.hash('User@123456', 12);
  const users = [];
  for (let i = 1; i <= 10; i++) {
    const user = await prisma.user.upsert({
      where: { email: `user${i}@test.vn` },
      update: {},
      create: {
        username: `player${i}`,
        email: `user${i}@test.vn`,
        password: userPassword,
        displayName: `Người Chơi ${i}`,
        role: 'USER',
        emailVerified: true,
        balance: Math.floor(Math.random() * 500000) + 50000,
        totalDeposit: Math.floor(Math.random() * 2000000) + 100000,
        totalSpent: Math.floor(Math.random() * 1000000),
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=user${i}`
      }
    });
    users.push(user);
  }
  console.log('✅ Test users created');

  // Create banners
  const bannerData = [
    {
      title: 'LIÊN QUÂN MOBILE SHOP',
      subtitle: 'Mua bán tài khoản uy tín - Giao dịch an toàn',
      imageUrl: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1200&h=400&fit=crop',
      linkUrl: '/shop',
      linkText: 'Mua Ngay',
      sortOrder: 1
    },
    {
      title: 'VÒNG QUAY MAY MẮN',
      subtitle: 'Quay ngay - Nhận thưởng hấp dẫn mỗi ngày',
      imageUrl: 'https://images.unsplash.com/photo-1614680376573-df3480f0c6ff?w=1200&h=400&fit=crop',
      linkUrl: '/lucky-wheel',
      linkText: 'Quay Ngay',
      sortOrder: 2
    },
    {
      title: 'Túi Mù',
      subtitle: 'Mở hộp - Nhận item hiếm không ngờ tới',
      imageUrl: 'https://images.unsplash.com/photo-1569003339405-ea396a5a8a90?w=1200&h=400&fit=crop',
      linkUrl: '/mystery-box',
      linkText: 'Mở Hộp',
      sortOrder: 3
    }
  ];

  for (const banner of bannerData) {
    await prisma.banner.create({ data: banner });
  }
  console.log('✅ Banners created');

  // Create game accounts
  const ranks = ['Đồng', 'Bạc', 'Vàng', 'Bạch Kim', 'Kim Cương', 'Tinh Anh', 'Đại Tinh Anh', 'Chinh Phục'];
  const servers = ['Server 1', 'Server 2', 'Server 3', 'Server 4', 'Server 5'];
  const accountTitles = [
    'Tài khoản Kim Cương full tướng',
    'ACC rank Tinh Anh 200+ tướng',
    'Tài khoản Chinh Phục siêu vip',
    'ACC đẹp full skin Liliana',
    'Tài khoản rank cao nhiều skin hiếm',
    'ACC Kim Cương I full gem',
    'Tài khoản mới rank vàng 50 tướng',
    'ACC Bạch Kim nhiều tướng mới',
    'Tài khoản Tinh Anh top server',
    'ACC siêu rẻ rank Kim Cương',
  ];

  const accountImages = [
    'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1542751110-97427bbecf20?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1586182987320-4f376d39d787?w=600&h=400&fit=crop',
    'https://images.unsplash.com/photo-1616588589676-62b3bd4ff6d2?w=600&h=400&fit=crop',
  ];

  const gameAccounts = [];
  for (let i = 1; i <= 30; i++) {
    const rank = ranks[Math.floor(Math.random() * ranks.length)];
    const price = Math.floor(Math.random() * 900000) + 100000;
    const champions = Math.floor(Math.random() * 150) + 20;
    const skins = Math.floor(Math.random() * 100) + 5;

    const account = await prisma.gameAccount.create({
      data: {
        code: `LQ${String(i).padStart(5, '0')}`,
        title: `${accountTitles[i % accountTitles.length]} #${i}`,
        description: `Tài khoản Liên Quân Mobile chất lượng cao. Rank ${rank}, ${champions} tướng, ${skins} skin. Bảo hành tài khoản 7 ngày. Hỗ trợ đổi thông tin sau mua.`,
        price: price,
        originalPrice: Math.random() > 0.5 ? price * 1.2 : null,
        server: servers[Math.floor(Math.random() * servers.length)],
        rank: rank,
        champions: champions,
        skins: skins,
        level: Math.floor(Math.random() * 50) + 10,
        winRate: (Math.random() * 40 + 40).toFixed(2),
        matches: Math.floor(Math.random() * 3000) + 100,
        gems: Math.floor(Math.random() * 50000),
        vouchers: Math.floor(Math.random() * 100),
        gameUsername: `lqacc${i}`,
        gamePassword: `Pass@${i}2024`,
        gameBindEmail: `lqacc${i}@gmail.com`,
        thumbnailUrl: accountImages[i % accountImages.length],
        isFeatured: i <= 6,
        isNew: i > 24,
        isVerified: Math.random() > 0.3,
        tags: JSON.stringify([rank, `${champions} tướng`, `${skins} skin`]),
        status: i > 28 ? 'SOLD' : 'AVAILABLE',
        images: {
          create: accountImages.slice(0, 3).map((url, idx) => ({
            url,
            publicId: `account_${i}_img_${idx}`,
            sortOrder: idx
          }))
        }
      }
    });
    gameAccounts.push(account);
  }
  console.log('✅ Game accounts created');

  // Create lucky wheel
  const wheel = await prisma.luckyWheel.create({
    data: {
      name: 'Vòng Quay Vận May',
      description: 'Quay để nhận những phần thưởng hấp dẫn',
      spinCost: 10000,
      isActive: true
    }
  });

  const wheelRewards = [
    { name: '50,000 VNĐ', type: 'BALANCE', value: 50000, probability: 0.05, rarity: 'LEGENDARY', color: '#FFD700' },
    { name: '20,000 VNĐ', type: 'BALANCE', value: 20000, probability: 0.10, rarity: 'EPIC', color: '#9B59B6' },
    { name: '10,000 VNĐ', type: 'BALANCE', value: 10000, probability: 0.15, rarity: 'RARE', color: '#3498DB' },
    { name: '5,000 VNĐ', type: 'BALANCE', value: 5000, probability: 0.20, rarity: 'RARE', color: '#2ECC71' },
    { name: '2,000 VNĐ', type: 'BALANCE', value: 2000, probability: 0.20, rarity: 'COMMON', color: '#95A5A6' },
    { name: 'Thêm lượt quay', type: 'SPIN', value: 10000, probability: 0.10, rarity: 'RARE', color: '#E74C3C' },
    { name: '100,000 VNĐ', type: 'BALANCE', value: 100000, probability: 0.01, rarity: 'MYTHIC', color: '#FF6B6B' },
    { name: '500 VNĐ', type: 'BALANCE', value: 500, probability: 0.19, rarity: 'COMMON', color: '#7F8C8D' },
  ];

  for (let i = 0; i < wheelRewards.length; i++) {
    await prisma.luckyWheelReward.create({
      data: { ...wheelRewards[i], wheelId: wheel.id, sortOrder: i }
    });
  }
  console.log('✅ Lucky wheel created');

  // Create mystery boxes
  const boxData = [
    {
      name: 'Hộp Bạc',
      description: 'Hộp bí ẩn cấp bạc - Chứa phần thưởng cơ bản',
      price: 20000,
      imageUrl: 'https://images.unsplash.com/photo-1607344645866-009c320b63e0?w=400&h=400&fit=crop',
    },
    {
      name: 'Hộp Vàng',
      description: 'Hộp bí ẩn cấp vàng - Nhiều phần thưởng quý hiếm',
      price: 50000,
      imageUrl: 'https://images.unsplash.com/photo-1589829085413-56de8ae18c73?w=400&h=400&fit=crop',
    },
    {
      name: 'Hộp Kim Cương',
      description: 'Hộp bí ẩn cấp kim cương - Phần thưởng cực kỳ giá trị',
      price: 100000,
      imageUrl: 'https://images.unsplash.com/photo-1615466247504-c239b073c5ef?w=400&h=400&fit=crop',
    }
  ];

  for (const boxInfo of boxData) {
    const box = await prisma.mysteryBox.create({ data: boxInfo });
    const multiplier = boxInfo.price / 20000;

    await prisma.mysteryBoxReward.createMany({
      data: [
        { boxId: box.id, name: `${5000 * multiplier} VNĐ`, type: 'BALANCE', value: 5000 * multiplier, probability: 0.40, rarity: 'COMMON' },
        { boxId: box.id, name: `${15000 * multiplier} VNĐ`, type: 'BALANCE', value: 15000 * multiplier, probability: 0.30, rarity: 'RARE' },
        { boxId: box.id, name: `${40000 * multiplier} VNĐ`, type: 'BALANCE', value: 40000 * multiplier, probability: 0.15, rarity: 'EPIC' },
        { boxId: box.id, name: `${100000 * multiplier} VNĐ`, type: 'BALANCE', value: 100000 * multiplier, probability: 0.10, rarity: 'EPIC' },
        { boxId: box.id, name: `${300000 * multiplier} VNĐ`, type: 'BALANCE', value: 300000 * multiplier, probability: 0.04, rarity: 'LEGENDARY' },
        { boxId: box.id, name: `${1000000 * multiplier} VNĐ`, type: 'BALANCE', value: 1000000 * multiplier, probability: 0.01, rarity: 'MYTHIC' },
      ]
    });
  }
  console.log('✅ Mystery boxes created');

  // Site configs
  await prisma.siteConfig.createMany({
    data: [
      { key: 'site_name', value: 'LQ Shop', group: 'general' },
      { key: 'site_description', value: 'Mua bán tài khoản Liên Quân Mobile uy tín', group: 'general' },
      { key: 'bank_code', value: 'MB', group: 'payment' },
      { key: 'bank_account_number', value: '0123456789', group: 'payment' },
      { key: 'bank_account_name', value: 'NGUYEN VAN A', group: 'payment' },
      { key: 'deposit_min', value: '10000', group: 'payment' },
      { key: 'deposit_max', value: '50000000', group: 'payment' },
      { key: 'deposit_expire_minutes', value: '30', group: 'payment' },
    ],
    skipDuplicates: true
  });
  console.log('✅ Site configs created');

  // Create rankings for users
  const now = new Date();
  const periodKey = `daily_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}`;
  for (const user of users) {
    await prisma.ranking.upsert({
      where: { userId_periodKey: { userId: user.id, periodKey } },
      update: {},
      create: {
        userId: user.id,
        period: 'daily',
        periodKey,
        totalDeposit: user.totalDeposit,
        totalSpent: user.totalSpent
      }
    });
  }
  console.log('✅ Rankings created');

  console.log('\n🎉 Seed completed successfully!');
  console.log('📧 Admin: admin@lienquanshop.vn / Admin@123456');
  console.log('📧 User: user1@test.vn / User@123456');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });