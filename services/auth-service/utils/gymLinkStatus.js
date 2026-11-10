// Has the gym confirmed this membership yet?
//
// New public QR claims are stored as self links and require gym approval.
// Attendance on a paid booking does not prove membership. Existing gym_qr
// links retain their approval. Returns null when there is no active link.
//
// Kept dependency-free on purpose: both the self-link response and GET /me read
// it, and /me must not pull the whole link service in just for this.
export function gymLinkStatus(link) {
  if (!link) return null;
  const confirmed = link.source !== 'self' || !!link.approvedAt;
  return confirmed ? 'approved' : 'pending';
}
