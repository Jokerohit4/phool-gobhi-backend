import * as gymService from '../services/gymService.js';
import { generateTimeSlots } from '../utils/slots.js';

export const listGyms = async (req, res) => {
  try {
    const { city, minPrice, maxPrice, search, amenities } = req.query;
    const gyms = await gymService.listGyms({
      city,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      search,
      amenities,
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

export const getGymSlots = async (req, res) => {
  try {
    const gym = await gymService.getGymById(parseInt(req.params.id));
    const slots = generateTimeSlots(gym.openTime, gym.closeTime, gym.slotDuration);
    res.json({ data: { slots, capacity: gym.capacity } });
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

export const createGym = async (req, res) => {
  try {
    const gym = await gymService.createGym(req.userId, req.body);
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

export const addReview = async (req, res) => {
  try {
    const { rating, comment } = req.body;
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
