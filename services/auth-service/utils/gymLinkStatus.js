// Has the gym confirmed this membership yet?
//
// A self-declared link is live immediately, but it is only "approved" once the
// gym approved it or a verified check-in confirmed it. A QR link is the gym's
// own doing, so it is approved from the start. Returns null when there is no
// active link at all.
//
// Kept dependency-free on purpose: both the self-link response and GET /me read
// it, and /me must not pull the whole link service in just for this.
export function gymLinkStatus(link) {
  if (!link) return null;
  const confirmed = link.source !== 'self' || !!link.approvedAt || !!link.firstVerifiedCheckinAt;
  return confirmed ? 'approved' : 'pending';
}
