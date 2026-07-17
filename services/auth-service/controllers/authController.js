
import { PrismaClient } from '@prisma/client';
import { signupService, loginService, deleteUserService, refreshTokenService, sendOtpService, verifyOtpService, verifyFirebaseTokenService, googleSignInService, listStaffService, createStaffService, updateStaffStatusService } from '../services/authService.js';

const prisma = new PrismaClient();

const signup = async (req, res) => {
  try {
    console.log('Signup request body:', req.body);
    const result = await signupService(req.body ?? {});
    res.status(201).json(result);
  } catch (err) {
    console.error('Signup controller error:', JSON.stringify(err, null, 2));
    // Include error code in response for debugging
    const response = { error: err.error || 'Unknown error' };
    if (err.errorCode) {
      response.errorCode = err.errorCode;
    }
    // In development, include more error details
    if (process.env.NODE_ENV !== 'production' && err.originalError) {
      response.details = {
        code: err.originalError.code,
        message: err.originalError.message,
        name: err.originalError.name,
      };
    }
    res.status(err.status || 500).json(response);
  }
};



const login = async (req, res) => {
  try {
    const result = await loginService(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Unknown error' });
  }
};

const deleteUser = async (req, res) => {
  try {
    console.log('req.user', req.user);
    const result = await deleteUserService(req.user.id);
    res.json(result);
  } catch (err) {
    console.log('err', err);
    res.status(err.status || 500).json({ error: err.error || 'Unknown error' });
  }
};

const refreshToken = async (req, res) => {
  try {
    const result = await refreshTokenService(req.body?.token);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Unknown error' });
  }
};

const sendOtp = async (req, res) => {
  try {
    const result = await sendOtpService(req.body?.phone);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const result = await verifyOtpService(req.body ?? {});
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const verifyFirebaseToken = async (req, res) => {
  try {
    const result = await verifyFirebaseTokenService(req.body ?? {});
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const googleSignIn = async (req, res) => {
  try {
    const result = await googleSignInService(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const getOtpConfig = (req, res) => {
  res.json({ provider: process.env.OTP_PROVIDER || 'fast2sms' });
};

const listStaff = async (req, res) => {
  try {
    const staff = await listStaffService();
    res.json({ data: staff });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const createStaff = async (req, res) => {
  try {
    const result = await createStaffService(req.body ?? {}, req.user.id);
    res.status(201).json({ data: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error', errorCode: err.errorCode });
  }
};

const updateStaffStatus = async (req, res) => {
  try {
    const updated = await updateStaffStatusService(req.params.id, !!req.body?.isActive, req.user.id);
    res.json({ data: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.error || 'Server error' });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      phone: user.phone,
      name: user.name,
      email: user.email,
      role: user.role,
      type: user.type,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      fitnessGoals: user.fitnessGoals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Internal: minimal profile lookup for other services to enforce "profile
// must be complete before X" rules (e.g. booking-service before createBooking)
// without duplicating user data or exposing it through a public route.
// Extended for buddy-service: gender/fitnessGoals seed its denormalized
// discovery-filter cache, profileImageUrl/fcmToken back match/chat display
// and push notifications (services/buddy-service/services/authClient.js).
const getUserInternal = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      fitnessGoals: user.fitnessGoals,
      profileImageUrl: user.profileImageUrl,
      fcmToken: user.fcmToken,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

// Internal: batched display-field lookup so a caller resolving N user ids
// (e.g. buddy-service rendering a discovery page/matches list, or
// wallet-service enriching partner-balance/payout admin views) can do it in
// one round trip instead of N. Deliberately narrow — display-only fields
// that are safe to fan out widely, unlike getUserInternal's fuller payload
// above (no fcmToken/dateOfBirth/fitnessGoals here).
const getUsersBatchInternal = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return res.json({ data: [] });
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phone: true, profileImageUrl: true },
    });
    res.json({ data: users });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

const updateFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken required' });
    await prisma.user.update({ where: { id: req.user.id }, data: { fcmToken } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
};

export { signup, login, deleteUser, refreshToken, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getMe, getUserInternal, getUsersBatchInternal, updateFcmToken, listStaff, createStaff, updateStaffStatus };


