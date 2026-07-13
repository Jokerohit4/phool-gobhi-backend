
import { PrismaClient } from '@prisma/client';
import { signupService, loginService, deleteUserService, refreshTokenService, sendOtpService, verifyOtpService, verifyFirebaseTokenService, googleSignInService } from '../services/authService.js';

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
const getUserInternal = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      name: user.name,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
    });
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

export { signup, login, deleteUser, refreshToken, sendOtp, verifyOtp, verifyFirebaseToken, googleSignIn, getOtpConfig, getMe, getUserInternal, updateFcmToken };


