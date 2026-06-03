const { PrismaClient } = require('@prisma/client')

const globalForPrisma = global

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

const prisma = globalForPrisma.prisma

module.exports = prisma