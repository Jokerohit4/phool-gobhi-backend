import { PrismaClient } from '@prisma/client';
import { signedResumeUrl } from '../utils/gcsResume.js';

const prisma = new PrismaClient();

const MAX_MESSAGE_LENGTH = 5000;

export async function submitJobApplication(jobOpeningId, { name, email, message, resumePath }) {
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
      resumePath: resumePath || null,
    },
  });
}

// Signed URLs are generated fresh here, not stored, so a resume submitted
// months ago is just as viewable as one from today (see utils/gcsResume.js).
// A signing failure (e.g. a missing IAM grant) must not take down the whole
// list — every other application, resume or not, still needs to render.
export async function listJobApplications() {
  const applications = await prisma.jobApplication.findMany({ orderBy: { createdAt: 'desc' } });
  return Promise.all(
    applications.map(async (application) => {
      let resumeUrl = null;
      try {
        resumeUrl = await signedResumeUrl(application.resumePath);
      } catch (err) {
        console.error(`Failed to sign resume URL for application ${application.id}:`, err.message);
      }
      return { ...application, resumeUrl };
    }),
  );
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
