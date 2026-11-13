import { PrismaClient } from '@prisma/client';

// Single shared PrismaClient for this service (one engine + one connection pool).
// Import this instead of calling new PrismaClient() anywhere else.
const prisma = new PrismaClient();

export default prisma;
export { prisma };
