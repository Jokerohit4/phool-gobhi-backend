import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VALID_EMPLOYMENT_TYPES = ['full_time', 'part_time', 'internship', 'contract'];

export async function listActiveJobOpenings() {
  return prisma.jobOpening.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
}

export async function listAllJobOpenings() {
  return prisma.jobOpening.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function createJobOpening({ title, department, location, employmentType, description }) {
  const trimmedTitle = String(title ?? '').trim();
  const trimmedDepartment = String(department ?? '').trim();
  const trimmedLocation = String(location ?? '').trim();
  const trimmedDescription = String(description ?? '').trim();

  if (!trimmedTitle) throw { status: 400, error: 'Title is required' };
  if (!trimmedDepartment) throw { status: 400, error: 'Department is required' };
  if (!trimmedLocation) throw { status: 400, error: 'Location is required' };
  if (!VALID_EMPLOYMENT_TYPES.includes(employmentType)) throw { status: 400, error: 'Invalid employment type' };
  if (!trimmedDescription) throw { status: 400, error: 'Description is required' };

  return prisma.jobOpening.create({
    data: {
      title: trimmedTitle,
      department: trimmedDepartment,
      location: trimmedLocation,
      employmentType,
      description: trimmedDescription,
    },
  });
}

export async function setJobOpeningActive(id, isActive) {
  try {
    return await prisma.jobOpening.update({
      where: { id: Number(id) },
      data: { isActive: !!isActive },
    });
  } catch (err) {
    if (err.code === 'P2025') throw { status: 404, error: 'Job opening not found' };
    throw err;
  }
}

export async function deleteJobOpening(id) {
  try {
    await prisma.jobOpening.delete({ where: { id: Number(id) } });
  } catch (err) {
    if (err.code === 'P2025') throw { status: 404, error: 'Job opening not found' };
    throw err;
  }
}
