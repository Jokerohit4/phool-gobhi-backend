import { Router } from 'express';
import { requireAuth, requireRole, requireInternal } from '../middleware/requireAuth.js';
import { uploadGymImage, uploadGymDoc } from '../utils/upload.js';
import * as ctrl from '../controllers/gymController.js';

const router = Router();

// Public routes (no auth needed)
router.get('/', ctrl.listGyms);
// Internal service-to-service only (e.g. booking-service resolving a gym by
// id) — returns the full row with no approval/active filtering, so this must
// never be reachable without the shared secret.
router.get('/internal/:id', requireInternal, ctrl.getGymInternal);
// Internal service-to-service: partner onboarding summary (auth-service, at login)
router.get('/internal/partner/:partnerId/summary', requireInternal, ctrl.getPartnerGymSummaryInternal);
// Internal service-to-service: booking-service resolves a class before booking it
router.get('/internal/classes/:classId', requireInternal, ctrl.getClassInternal);

// Pending-edit-request admin queue — MUST stay above `GET /:id` below: both
// are one path segment, so Express would otherwise treat "edit-requests" as
// an `:id` value (same footgun class as this service's gym-health route
// ordering). ?status=pending|approved|rejected
router.get('/edit-requests', requireRole('gobhi'), ctrl.listEditRequestsAdmin);
router.get('/edit-requests/:id', requireRole('gobhi'), ctrl.getEditRequestAdmin);
router.put('/edit-requests/:id/approve', requireRole('gobhi'), ctrl.approveEditRequest);
// Body: {reason} (required)
router.put('/edit-requests/:id/reject', requireRole('gobhi'), ctrl.rejectEditRequest);

// Same footgun, same fix — must stay above GET /:id. ?type=image|doc
router.get('/upload-signature', requireRole('partner'), ctrl.getUploadSignature);

router.get('/:id', ctrl.getGym);
router.get('/:id/slots', ctrl.getGymSlots);
router.get('/:id/availability', ctrl.getGymAvailability);
router.get('/:id/reviews', ctrl.getGymReviews);
router.get('/:id/subscription-plans', ctrl.getSubscriptionPlans);

// Places autocomplete proxy — any authenticated user (web or mobile,
// partner or customer), not partner-only, since address search is a
// generic need. Key lives only server-side; see services/placesService.js.
router.get('/places/autocomplete', requireAuth, ctrl.placesAutocomplete);
router.get('/places/details', requireAuth, ctrl.placesDetails);

// Partner routes
router.get('/partner/mine', requireRole('partner'), ctrl.getPartnerGyms);
router.post('/', requireRole('partner'), ctrl.createGym);
router.put('/:id', requireRole('partner'), ctrl.updateGym);
router.put('/:id/refresh-google-rating', requireRole('partner'), ctrl.refreshGoogleRating);
router.delete('/:id', requireRole('partner'), ctrl.deleteGym);
router.post('/:id/images', requireRole('partner'), uploadGymImage.single('image'), ctrl.addGymImage);
router.delete('/:id/images/:imageId', requireRole('partner'), ctrl.deleteGymImage);
// Brand/verification documents (field 'file'); stored as URLs in Gym.brandDocs[]
router.post('/:id/docs', requireRole('partner'), uploadGymDoc.single('file'), ctrl.addGymDoc);
router.delete('/:id/docs', requireRole('partner'), ctrl.deleteGymDoc);
router.get('/:id/slot-prices', requireRole('partner'), ctrl.getSlotPrices);
router.put('/:id/slot-prices', requireRole('partner'), ctrl.updateSlotPrices);
// A partner's own pending/reviewed edit requests for this gym (status banners).
router.get('/:id/edit-requests', requireRole('partner'), ctrl.getPartnerEditRequests);
router.post('/upload', requireAuth, uploadGymImage.single('file'), ctrl.uploadGenericImage);

// Admin-only routes — require role 'gobhi'
// To approve: create an account with role:'gobhi' via POST /api/auth/signup, login, use the JWT
// Body: {} or {approved:true} to approve; {approved:false, reason:"..."} to reject (reason required)
router.put('/:id/approve', requireRole('gobhi'), ctrl.approveGym);
// Body: {commissionPct: number} (0-100) — overrides this gym's platform commission rate (default 20).
router.put('/:id/commission', requireRole('gobhi'), ctrl.updateGymCommission);
// List all gyms regardless of owner/approval status; ?status=pending|approved|rejected
router.get('/admin/all', requireRole('gobhi'), ctrl.listGymsAdmin);
// Single-gym lookup that doesn't 404 on pending/rejected gyms (unlike GET /:id above)
router.get('/admin/:id', requireRole('gobhi'), ctrl.getGymAdmin);
// Review moderation — remove a fake/abusive review; recomputes the gym's rating.
router.delete('/:id/reviews/:reviewId', requireRole('gobhi'), ctrl.deleteReview);
// Soft delete/restore (reversible) — hides the gym from discovery without losing data. Body: {isActive}
router.put('/admin/:id/status', requireRole('gobhi'), ctrl.setGymActiveAdmin);
// Hard delete (irreversible) — refuses if the gym has booking history; see ctrl.deleteGymAdmin.
router.delete('/admin/:id', requireRole('gobhi'), ctrl.deleteGymAdmin);

// Customer routes
router.post('/:id/reviews', requireRole('customer'), ctrl.addReview);

// Slot block routes (partner only)
router.get('/:id/blocks', requireRole('partner'), ctrl.getSlotBlocks);
router.post('/:id/blocks', requireRole('partner'), ctrl.createSlotBlock);
router.delete('/:id/blocks/:blockId', requireRole('partner'), ctrl.deleteSlotBlock);

// Per-day-of-week operating hours — public read (website/app display),
// partner-editable (goes through the same edit-request approval gate as
// every other live-gym mutation once isApproved).
router.get('/:id/operating-hours', ctrl.getOperatingHours);
router.put('/:id/operating-hours', requireRole('partner'), ctrl.updateOperatingHours);

// Recurring bookable classes — public read (customer browse/book), partner CRUD.
router.get('/:id/classes', ctrl.getClasses);
router.get('/:id/classes/:classId/occurrences', ctrl.getClassOccurrences);
router.post('/:id/classes', requireRole('partner'), ctrl.createClass);
router.put('/:id/classes/:classId', requireRole('partner'), ctrl.updateClass);
router.delete('/:id/classes/:classId', requireRole('partner'), ctrl.deleteClass);

export default router;
