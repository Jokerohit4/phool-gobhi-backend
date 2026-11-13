import { PrismaClient } from '@prisma/client';

// Single shared PrismaClient per service: one engine + one connection pool.
// Import this instead of calling `new PrismaClient()` in modules.
const prisma = new PrismaClient();

export default prisma;
export { prisma };
