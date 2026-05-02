// Base response builder
export function baseResponse({ status, errorCode = null, errorMessage = null, data = null, meta = null }) {
  return {
    status,
    errorCode,
    errorMessage,
    data,
    timestamp: new Date().toISOString(),
    ...(meta && { meta }),
  };
}

// Success response
export function successResponse(data = null, meta = null) {
  return baseResponse({ status: 'success', data, meta });
}

// Error response
export function errorResponse(errorCode, errorMessage, meta = null) {
  return baseResponse({ status: 'error', errorCode, errorMessage, meta });
} 