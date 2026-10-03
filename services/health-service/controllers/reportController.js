import { Request, Response } from 'express';
import { 
  createReportService, 
  processReportService, 
  getPendingExtractionsService, 
  verifyExtractionService 
} from '../services/reportService.js';

export const uploadReport = async (req, res) => {
  try {
    const { cloudinaryUrl, fileName } = req.body;
    const userId = req.user.id;

    if (!cloudinaryUrl || !fileName) {
      return res.status(400).json({ error: 'Cloudinary URL and fileName are required' });
    }

    const report = await createReportService({ userId, cloudinaryUrl, fileName });
    
    // Trigger async processing - we don't wait for the OCR to finish
    // because it can take several seconds/minutes.
    processReportService(report.id).catch(err => 
      console.error(`Async processing failed for report ${report.id}:`, err)
    );

    res.status(201).json({ 
      message: 'Report uploaded successfully. Processing has started.', 
      reportId: report.id 
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const getPendingExtractions = async (req, res) => {
  try {
    const userId = req.user.id;
    const extractions = await getPendingExtractionsService(userId);
    res.json({ data: extractions });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};

export const verifyExtraction = async (req, res) => {
  try {
    const { extractionId, confirmedValue } = req.body;
    const userId = req.user.id;

    if (!extractionId || confirmedValue === undefined) {
      return res.status(400).json({ error: 'extractionId and confirmedValue are required' });
    }

    const result = await verifyExtractionService({ 
      extractionId: Number(extractionId), 
      userId, 
      confirmedValue: Number(confirmedValue) 
    });

    res.json({ message: result.message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Internal server error' });
  }
};
