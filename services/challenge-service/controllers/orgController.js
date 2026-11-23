import * as orgs from '../services/orgService.js';
import { getBoardStandings, getBoardStandingsAdmin } from '../services/orgLeaderboardService.js';

// Thin HTTP layer. Services throw `{ status, error }` for anything the caller
// should see (4xx keeps its message); everything else is a generic 500.
function fail(res, err, context) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error(`orgController ${context}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : (err.error || err.message || 'Request failed') });
}

const wrap = (context, fn) => async (req, res) => {
  try { res.json({ data: await fn(req) }); } catch (err) { fail(res, err, context); }
};

// ---- Members ----
export const getMyOrganizations = wrap('getMyOrganizations', (req) => orgs.getMyOrganizations(req.userId).then((organizations) => ({ organizations })));
export const getMyBoard = wrap('getMyBoard', (req) => getBoardStandings(req.params.orgId, req.params.boardId, req.userId));

// ---- Staff (gobhi) ----
export const listOrgsAdmin = wrap('listOrgsAdmin', () => orgs.listOrgs());
export const createOrgAdmin = (req, res) => orgs.createOrg(req.body ?? {}, req.userId)
  .then((data) => res.status(201).json({ data })).catch((e) => fail(res, e, 'createOrgAdmin'));
export const getOrgAdmin = wrap('getOrgAdmin', (req) => orgs.getOrgDetail(req.params.id));
export const updateOrgAdmin = wrap('updateOrgAdmin', (req) => orgs.updateOrg(req.params.id, req.body ?? {}));
export const addMembersAdmin = wrap('addMembersAdmin', (req) => orgs.addMembers(req.params.id, req.body?.members, req.userId));
export const removeMemberAdmin = wrap('removeMemberAdmin', (req) => orgs.removeMember(req.params.id, req.params.memberId));
export const setMemberTeamAdmin = wrap('setMemberTeamAdmin', (req) => orgs.setMemberTeam(req.params.id, req.params.memberId, req.body?.teamId));
export const createTeamAdmin = (req, res) => orgs.createTeam(req.params.id, req.body?.name)
  .then((data) => res.status(201).json({ data })).catch((e) => fail(res, e, 'createTeamAdmin'));
export const renameTeamAdmin = wrap('renameTeamAdmin', (req) => orgs.renameTeam(req.params.id, req.params.teamId, req.body?.name));
export const deleteTeamAdmin = wrap('deleteTeamAdmin', (req) => orgs.deleteTeam(req.params.id, req.params.teamId));
export const createBoardAdmin = (req, res) => orgs.createLeaderboard(req.params.id, req.body ?? {}, req.userId)
  .then((data) => res.status(201).json({ data })).catch((e) => fail(res, e, 'createBoardAdmin'));
export const updateBoardAdmin = wrap('updateBoardAdmin', (req) => orgs.updateLeaderboard(req.params.id, req.params.boardId, req.body ?? {}));
export const getBoardAdmin = wrap('getBoardAdmin', (req) => getBoardStandingsAdmin(req.params.id, req.params.boardId));

// ---- Internal ----
// A scheduler (or anyone with the internal key) can persist expiry; it is also
// run lazily on every read, so skipping it never changes what members see.
export const sweepInternal = wrap('sweepInternal', () => orgs.sweepExpiredOrgs().then((expired) => ({ expired })));
