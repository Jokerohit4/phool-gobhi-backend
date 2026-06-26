import * as gymService from '../services/gymService.js';
import { generateTimeSlots } from '../utils/slots.js';
import { track } from '../utils/analytics.js';

const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://booking-service:5005';

export const listGyms = async (req, res) => {
  try {
    const { city, minPrice, maxPrice, search, amenities } = req.query;
    const userLat = parseFloat(req.headers['x-user-lat']);
    const userLng = parseFloat(req.headers['x-user-lng']);
    const gyms = await gymService.listGyms({
      city,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      search,
      amenities,
      userLat: isNaN(userLat) ? null : userLat,
      userLng: isNaN(userLng) ? null : userLng,
    });
    res.json({ data: gyms });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGym = async (req, res) => {
  try {
    const gym = await gymService.getGymById(parseInt(req.params.id));
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymInternal = async (req, res) => {
  try {
    const gym = await gymService.getGymByIdRaw(parseInt(req.params.id));
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymSlots = async (req, res) => {
  try {
    const gymId = parseInt(req.params.id);
    const { date } = req.query;

    const gym = await gymService.getGymById(gymId);
    let slots = generateTimeSlots(gym.openTime, gym.closeTime, gym.slotDuration);

    // Filter out blocked slots for the requested date
    if (date) {
      const blocks = await gymService.getSlotBlocks(gymId, date);
      const blockedTimes = new Set(blocks.map(b => b.startTime));
      slots = slots.filter(s => !blockedTimes.has(s.startTime));
    }

    // Annotate each slot with real availability from existing bookings (best-effort).
    // If booking-service is unreachable, fall back to assuming all slots are open.
    let counts = {};
    if (date) {
      try {
        const resp = await fetch(
          `${BOOKING_SERVICE_URL}/internal/slot-counts/${gymId}?date=${encodeURIComponent(date)}`,
          { headers: { 'x-internal-key': process.env.INTERNAL_API_KEY || '' } }
        );
        if (resp.ok) {
          const body = await resp.json();
          counts = body.data || {};
        }
      } catch (_) {
        // booking-service down — leave counts empty so slots still render
      }
    }

    const annotated = slots
      .map(s => {
        const booked = counts[s.startTime] || 0;
        const available = Math.max(gym.capacity - booked, 0);
        return { ...s, booked, available };
      })
      .filter(s => s.available > 0);

    res.json({ data: { slots: annotated, capacity: gym.capacity } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getPartnerGyms = async (req, res) => {
  try {
    const gyms = await gymService.getPartnerGyms(req.userId);
    res.json({ data: gyms });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

// Internal: onboarding summary for a partner (auth-service calls this at login).
export const getPartnerGymSummaryInternal = async (req, res) => {
  try {
    const summary = await gymService.getPartnerGymSummary(parseInt(req.params.partnerId));
    res.json({ data: summary });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const createGym = async (req, res) => {
  try {
    const gym = await gymService.createGym(req.userId, req.body);
    // Supply funnel: a gym is created already submitted for approval (isApproved=false).
    track('gym_created', req.userId, {
      gym_id: gym.id, city: gym.city, session_price: gym.sessionPrice,
    });
    res.status(201).json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const updateGym = async (req, res) => {
  try {
    const gym = await gymService.updateGym(parseInt(req.params.id), req.userId, req.body);
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteGym = async (req, res) => {
  try {
    const gym = await gymService.softDeleteGym(parseInt(req.params.id), req.userId);
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const addGymImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }
    const image = await gymService.addGymImage(
      parseInt(req.params.id),
      req.userId,
      req.file.path,
      req.file.filename
    );
    res.status(201).json({ data: image });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteGymImage = async (req, res) => {
  try {
    const result = await gymService.deleteGymImage(
      parseInt(req.params.id),
      parseInt(req.params.imageId),
      req.userId
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const addGymDoc = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No document provided' });
    }
    const brandDocs = await gymService.addGymDoc(
      parseInt(req.params.id),
      req.userId,
      req.file.path
    );
    res.status(201).json({ data: { url: req.file.path, brandDocs } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const deleteGymDoc = async (req, res) => {
  try {
    const url = req.body?.url || req.query?.url;
    if (!url) {
      return res.status(400).json({ error: 'Document url is required' });
    }
    const brandDocs = await gymService.deleteGymDoc(
      parseInt(req.params.id),
      req.userId,
      url
    );
    res.json({ data: { brandDocs } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const addReview = async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const r = Number(rating);
    if (!rating || r < 1 || r > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    const review = await gymService.addReview(
      parseInt(req.params.id),
      req.userId,
      rating,
      comment
    );
    res.status(201).json({ data: review });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You have already reviewed this gym' });
    }
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getGymReviews = async (req, res) => {
  try {
    const reviews = await gymService.getGymReviews(parseInt(req.params.id));
    res.json({ data: reviews });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const approveGym = async (req, res) => {
  try {
    const gym = await gymService.approveGym(parseInt(req.params.id));
    // Supply funnel: gobhi approved the gym; keyed to the owning partner.
    track('gym_approved', gym.partnerId, { gym_id: gym.id, city: gym.city });
    res.json({ data: gym });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message || 'Server error' });
  }
};

export const getSlotBlocks = async (req, res) => {
  try {
    const { date } = req.query;
    const blocks = await gymService.getSlotBlocks(parseInt(req.params.id), date);
    res.json({ data: blocks });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message });
  }
};

export const createSlotBlock = async (req, res) => {
  try {
    const block = await gymService.createSlotBlock(
      parseInt(req.params.id),
      req.userId,
      req.body
    );
    res.status(201).json({ data: block });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message });
  }
};

export const deleteSlotBlock = async (req, res) => {
  try {
    const result = await gymService.deleteSlotBlock(
      parseInt(req.params.blockId),
      req.userId
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || err.message });
  }
};
