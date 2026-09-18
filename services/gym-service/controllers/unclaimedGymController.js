import * as unclaimedGymService from '../services/unclaimedGymService.js';

// POST /unclaimed — "I train here". Resolves a Google Places id into either an
// existing partner gym (in which case the app should use the normal booking
// flow) or an UnclaimedGym row the customer can GPS-check-in against.
export const resolvePlace = async (req, res) => {
  try {
    const { placeId, sessiontoken } = req.body || {};
    const result = await unclaimedGymService.resolvePlaceService(
      placeId,
      req.userId,
      sessiontoken
    );
    res.json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal: booking-service needs the coordinates to run its geofence check.
export const getUnclaimedGymInternal = async (req, res) => {
  try {
    const gym = await unclaimedGymService.getUnclaimedGymService(parseInt(req.params.id));
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Admin (gobhi): the partner-acquisition list — gyms our own users have told
// us they already train at. This is the point of the whole feature beyond the
// customer-facing half.
export const listUnclaimedGymsAdmin = async (req, res) => {
  try {
    const gyms = await unclaimedGymService.listUnclaimedGymsService({
      claimStatus: req.query.claimStatus,
    });
    res.json({ data: gyms });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateClaimStatusAdmin = async (req, res) => {
  try {
    const { claimStatus, claimedGymId } = req.body || {};
    const gym = await unclaimedGymService.updateClaimStatusService(
      parseInt(req.params.id),
      { claimStatus, claimedGymId }
    );
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};
