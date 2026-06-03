const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_CA_CERT
        ? `${process.env.DATABASE_URL}?sslcert=/tmp/ca.pem`
        : process.env.DATABASE_URL,
    },
  },
})

// Ghi CA cert ra file tạm khi khởi động
if (process.env.DATABASE_CA_CERT) {
  const fs = require('fs')
  const cert = Buffer.from(process.env.DATABASE_CA_CERT, 'base64').toString('utf-8')
  fs.writeFileSync('/tmp/ca.pem', cert)
}

module.exports = prisma