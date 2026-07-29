import jwt from 'jsonwebtoken';

export const generateAccessToken = (userId, role, type) => {
  return jwt.sign({ id: userId, role, type }, process.env.JWT_SECRET, {
    expiresIn: '15m',
  });
};

// Signs a refresh JWT for one row of the RefreshToken rotation chain
// (services/refreshTokenService.js owns creating/rotating those rows — this
// is pure signing). `expiresAt` is the family's fixed absolute expiry, not
// extended per rotation, so total session length stays 7 days regardless of
// how many times the token gets rotated in that window.
export const signRefreshToken = (userId, jti, familyId, expiresAt) => {
  const expiresInSeconds = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  );
  return jwt.sign({ id: userId, jti, familyId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: expiresInSeconds,
  });
};
