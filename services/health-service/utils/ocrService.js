import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_PROJECT_ID = process.env.GOOGLE_PROJECT_ID;
const LOCATION = 'us'; // or 'eu'
const PROCESSOR_ID = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;

/**
 * Interface for Document AI's OCR processing.
 * Uses the 'FORM_PARSER_PROCESSOR' or 'HEALTH_REPORT_PROCESSOR' if available.
 */
export async function extractBiomarkersFromPDF(pdfUrl) {
  if (!GOOGLE_PROJECT_ID || !PROCESSOR_ID) {
    console.error('Google Document AI credentials missing');
    throw new Error('OCR_CONFIG_MISSING');
  }

  try {
    // Note: In a real GCP environment, we would use the @google-cloud/documentai SDK.
    // This implementation uses the REST API for transparency and fewer heavy dependencies.
    const accessToken = await getGoogleAccessToken();
    
    const response = await axios.post(
      `https://${LOCATION}-documentai.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}:process`,
      {
        rawDocument: {
          mimeType: 'application/pdf',
          content: await fetchPdfAsBase64(pdfUrl),
        },
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    return parseDocumentAIResponse(response.data);
  } catch (err) {
    console.error('OCR API Error:', err.response?.data || err.message);
    throw err;
  }
}

async function fetchPdfAsBase64(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function getGoogleAccessToken() {
  // In production, this uses a Service Account JSON key via google-auth-library.
  // For this implementation, we assume the environment is already authenticated
  // via GCP Application Default Credentials (ADC).
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getKsClient();
  const token = await auth.getAccessToken();
  return token.token;
}

function parseDocumentAIResponse(data) {
  const entities = data.document.entities || [];
  const results = [];

  // Map of common lab report labels to our BiometricMetric enum
  const METRIC_MAP = {
    'hemoglobin a1c': 'hbA1c',
    'hba1c': 'hbA1c',
    'fasting glucose': 'glucose',
    'glucose': 'glucose',
    'low density lipoprotein': 'ldl',
    'ldl': 'ldl',
    'high sensitivity c-reactive protein': 'hsCRP',
    'hscrp': 'hsCRP',
    'tsh': 'tsh',
    'vitamin d': 'vitamin_d',
    'b12': 'vitamin_b12',
  };

  for (const entity of entities) {
    const label = entity.mentionText.toLowerCase();
    const valueMatch = entity.mentionText.match(/(\d+(\.\d+)?)/);
    
    if (valueMatch) {
      const normalizedLabel = Object.keys(METRIC_MAP).find(k => label.includes(k));
      if (normalizedLabel) {
        results.push({
          metric: METRIC_MAP[normalizedLabel],
          rawValue: entity.mentionText,
          normalizedValue: parseFloat(valueMatch[0]),
          unit: extractUnit(entity.mentionText),
          confidence: entity.confidence || 0,
        });
      }
    }
  }

  return results;
}

function extractUnit(text) {
  const units = ['%', 'mg/dL', 'mmol/L', 'bpm', 'kg', 'g/dL'];
  for (const unit of units) {
    if (text.includes(unit)) return unit;
  }
  return 'unknown';
}
