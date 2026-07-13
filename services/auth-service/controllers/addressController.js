import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function formatAddress(addr) {
  return {
    id: addr.id,
    label: addr.label,
    formattedAddress: addr.formattedAddress,
    lat: addr.lat,
    lng: addr.lng,
  };
}

// GET /users/:userId/addresses
export const listAddresses = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });

    const addresses = await prisma.savedAddress.findMany({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: addresses.map(formatAddress) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// POST /users/:userId/addresses — body: { label, formattedAddress, lat, lng }
export const createAddress = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });

    const { label, formattedAddress, lat, lng } = req.body;
    if (!label || typeof label !== 'string') {
      return res.status(400).json({ error: 'label is required' });
    }
    if (!formattedAddress || typeof formattedAddress !== 'string') {
      return res.status(400).json({ error: 'formattedAddress is required' });
    }
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ error: 'lat and lng must be numbers' });
    }

    const address = await prisma.savedAddress.create({
      data: { userId: targetUserId, label, formattedAddress, lat: latNum, lng: lngNum },
    });
    res.status(201).json({ data: formatAddress(address) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// DELETE /users/:userId/addresses/:addressId
export const deleteAddress = async (req, res) => {
  try {
    const requestingUserId = parseInt(req.headers['x-user-id']);
    const targetUserId = parseInt(req.params.userId);
    if (requestingUserId !== targetUserId) return res.status(403).json({ error: 'Forbidden' });

    const address = await prisma.savedAddress.findUnique({
      where: { id: parseInt(req.params.addressId) },
    });
    if (!address || address.userId !== targetUserId) {
      return res.status(404).json({ error: 'Address not found' });
    }

    await prisma.savedAddress.delete({ where: { id: address.id } });
    res.json({ message: 'Address deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};
