import { PrismaClient } from '@prisma/client';

// Single shared Prisma client for the whole service (one engine + one pool).
// Do not call new PrismaClient() anywhere else in runtime code.
const prisma = new PrismaClient();

export default prisma;
export { prisma };
