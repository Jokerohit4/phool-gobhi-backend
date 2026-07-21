import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MAX_MESSAGE_LENGTH = 5000;

export async function submitJobApplication(jobOpeningId, { name, email, message }) {
  const id = Number(jobOpeningId);
  if (!id) throw { status: 400, error: 'A valid job opening id is required' };

  const job = await prisma.jobOpening.findUnique({ where: { id } });
  if (!job || !job.isActive) throw { status: 404, error: 'This job opening is no longer accepting applications' };

  const trimmedName = String(name ?? '').trim();
  const trimmedEmail = String(email ?? '').trim().toLowerCase();
  const trimmedMessage = String(message ?? '').trim();

  if (!trimmedName) throw { status: 400, error: 'Name is required' };
  if (!trimmedEmail || !trimmedEmail.includes('@')) throw { status: 400, error: 'A valid email is required' };
  if (!trimmedMessage) throw { status: 400, error: 'Message is required' };
  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) throw { status: 400, error: 'Message is too long' };

  return prisma.jobApplication.create({
    data: {
      jobOpeningId: id,
      jobTitle: job.title,
      name: trimmedName,
      email: trimmedEmail,
      message: trimmedMessage,
    },
  });
}

export async function listJobApplications() {
  return prisma.jobApplication.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function markJobApplicationRead(id, isRead) {
  try {
    return await prisma.jobApplication.update({
      where: { id: Number(id) },
      data: { isRead: !!isRead },
    });
  } catch (err) {
    if (err.code === 'P2025') throw { status: 404, error: 'Application not found' };
    throw err;
  }
}
