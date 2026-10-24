// Only synthetic local credentials are supplied to the rehearsal. Never upload URIs/tokens.
export function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[redacted]');
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>\\]+/gi, '[redacted-db-uri]')
    .replace(/\bBearer\s+[^\s"'<>\\]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]')
    .replace(/((?:POSTGRES_PASSWORD|JWT_SECRET|INTERNAL_API_KEY)\s*[=:]\s*)[^\s,"'<>\\]+/gi, '$1[redacted]')
    .replaceAll('e10-local-only', '[redacted-local-secret]');
}
