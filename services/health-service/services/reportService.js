import { PrismaClient } from '@prisma/client';
import { track } from '../utils/analytics.js';
import { extractBiomarkersFromPDF } from '../utils/ocrService.js';

const prisma = new PrismaClient();

/**
 * Service to handle medical report uploads and biomarker extraction.
 * Part of the "Local Health Vault" implementation.
 */
export async function createReportService({ userId, cloudinaryUrl, fileName }) {
  try {
    const report = await prisma.healthReport.create({
      data: {
        userId,
        cloudinaryUrl,
        fileName,
        status: 'PENDING',
      },
    });

    track('health_report_uploaded', userId, { fileName, status: 'PENDING' });
    return report;
  } catch (err) {
    console.error('createReportService error:', err);
    throw { status: 500, error: 'Failed to record report upload' };
  }
}

/**
 * Orchestrates the OCR extraction process.
 * Now integrated with Google Document AI via ocrService.js.
 */
export async function processReportService(reportId) {
  try {
    const report = await prisma.healthReport.findUnique({
      where: { id: reportId },
    });

    if (!report) throw { status: 404, error: 'Report not found' };

    // Update status to processing
    await prisma.healthReport.update({
      where: { id: reportId },
      data: { status: 'PROCESSING' },
    });

    // Use the real OCR service to extract markers from the PDF
    const extractions = await extractBiomarkersFromPDF(report.cloudinaryUrl);

    if (!extractions || extractions.length === 0) {
      await prisma.healthReport.update({
        where: { id: reportId },
        data: { status: 'FAILED' },
      });
      return { status: 'FAILED', message: 'No biomarkers extracted' };
    }

    // Save extractions to the database
    await prisma.reportExtraction.createMany({
      data: extractions.map(ex => ({
        reportId,
        metric: ex.metric,
        rawValue: ex.rawValue,
        normalizedValue: ex.normalizedValue,
        unit: ex.unit,
        confidence: ex.confidence,
        isVerified: false,
      })),
    });

    await prisma.healthReport.update({
      where: { id: reportId },
      data: { 
        status: 'COMPLETED',
        processedAt: new Date(),
      },
    });

    return { status: 'COMPLETED', extractionsCount: extractions.length };
  } catch (err) {
    console.error('processReportService error:', err);
    await prisma.healthReport.update({
      where: { id: reportId },
      data: { status: 'FAILED' },
    }).catch(() => {});
    throw { status: 500, error: 'Report processing failed' };
  }
}

export async function getPendingExtractionsService(userId) {
  try {
    const reports = await prisma.healthReport.findMany({
      where: { 
        userId,
        status: 'COMPLETED',
      },
      include: {
        extractions: {
          where: { isVerified: false },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Flatten the reports into a list of pending extractions for the UI
    return reports.flatMap(r => 
      r.extractions.map(ex => ({
        ...ex,
        reportId: r.id,
        reportFileName: r.fileName,
      }))
    );
  } catch (err) {
    console.error('getPendingExtractionsService error:', err);
    throw { status: 500, error: 'Failed to fetch pending extractions' };
  }
}

export async function verifyExtractionService({ extractionId, userId, confirmedValue }) {
  try {
    const extraction = await prisma.reportExtraction.findUnique({
      where: { id: extractionId },
    });

    if (!extraction) throw { status: 404, error: 'Extraction record not found' };
    
    // Security check: ensure the extraction belongs to a report owned by the user
    const report = await prisma.healthReport.findUnique({
      where: { id: extraction.reportId },
    });
    if (!report || report.userId !== userId) {
      throw { status: 403, error: 'Forbidden' };
    }

    // 1. Update the extraction as verified
    await prisma.reportExtraction.update({
      where: { id: extractionId },
      data: { 
        isVerified: true,
        normalizedValue: confirmedValue // User might have corrected the AI's value
      },
    });

    // 2. Sync to the main BiometricEntry table (The la la land of biological data)
    // This ensures the value is now part of the user's health history
    await prisma.biometricEntry.upsert({
      where: {
        userId_metric_localDate: {
          userId,
          metric: extraction.metric,
          localDate: new Date().toISOString().split('T')[0], // Use current date or report date if available
        },
      },
      update: {
        value: confirmedValue,
        source: 'manual', // Marked as manual because the user verified/corrected it
      },
      create: {
        userId,
        metric: extraction.metric,
        value: confirmedValue,
        unit: extraction.unit || 'unknown',
        source: 'manual',
        localDate: new Date().toISOString().split('T')[0],
      },
    });

    return { message: 'Biomarker verified and saved to health history' };
  } catch (err) {
    console.error('verifyExtractionService error:', err);
    throw err;
  }
}
