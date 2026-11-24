import { Router } from 'express';
import { requireAuth, requireInternal, requireRole } from '../middleware/requireAuth.js';
import * as ctrl from '../controllers/orgController.js';

// Corporate wellness. Mounted BEFORE the challenge router (see app.js) because
// that router has a bare `/:id` that would otherwise swallow `/orgs`.
//
// Deliberately NOT behind a feature flag: access is the member list itself.
// Nobody who has not been added by staff gets anything back, and a company
// that expires simply stops being returned.
const router = Router();

// Members: only ever see companies they were added to.
router.get('/orgs/me', requireAuth, ctrl.getMyOrganizations);
router.get('/orgs/:orgId/leaderboards/:boardId', requireAuth, ctrl.getMyBoard);

// Staff (gobhi): create companies, manage members, teams and leaderboards.
router.get('/admin/orgs', requireRole('gobhi'), ctrl.listOrgsAdmin);
router.post('/admin/orgs', requireRole('gobhi'), ctrl.createOrgAdmin);
router.get('/admin/orgs/:id', requireRole('gobhi'), ctrl.getOrgAdmin);
router.put('/admin/orgs/:id', requireRole('gobhi'), ctrl.updateOrgAdmin);
router.get('/admin/orgs/:id/dashboard', requireRole('gobhi'), ctrl.getDashboardAdmin);
router.post('/admin/orgs/:id/members', requireRole('gobhi'), ctrl.addMembersAdmin);
router.put('/admin/orgs/:id/members/:memberId', requireRole('gobhi'), ctrl.setMemberTeamAdmin);
router.delete('/admin/orgs/:id/members/:memberId', requireRole('gobhi'), ctrl.removeMemberAdmin);
router.post('/admin/orgs/:id/teams', requireRole('gobhi'), ctrl.createTeamAdmin);
router.put('/admin/orgs/:id/teams/:teamId', requireRole('gobhi'), ctrl.renameTeamAdmin);
router.delete('/admin/orgs/:id/teams/:teamId', requireRole('gobhi'), ctrl.deleteTeamAdmin);
router.post('/admin/orgs/:id/leaderboards', requireRole('gobhi'), ctrl.createBoardAdmin);
router.get('/admin/orgs/:id/leaderboards/:boardId', requireRole('gobhi'), ctrl.getBoardAdmin);
router.put('/admin/orgs/:id/leaderboards/:boardId', requireRole('gobhi'), ctrl.updateBoardAdmin);

// Internal: persist expiry. Optional (expiry is also decided on every read).
router.post('/internal/orgs/sweep', requireInternal, ctrl.sweepInternal);

export default router;
