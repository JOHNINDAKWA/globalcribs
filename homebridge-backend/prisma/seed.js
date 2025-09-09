// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const pass = await bcrypt.hash('secret123', 10);

  const users = [
    { email: 'student1@example.com', name: 'Jane Student', role: 'STUDENT' },
    { email: 'student2@example.com', name: 'John Student', role: 'STUDENT' },
    { email: 'agent1@example.com',   name: 'Alex Agent',   role: 'AGENT'   },
    { email: 'agent2@example.com',   name: 'Riley Agent',  role: 'AGENT'   },
    { email: 'admin@homebridge.com', name: 'Admin User',   role: 'ADMIN'   },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        status: 'ACTIVE',
        passwordHash: pass,
      },
    });
  }

  console.log('Seeded users.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
