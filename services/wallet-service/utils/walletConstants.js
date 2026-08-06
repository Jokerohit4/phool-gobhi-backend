// Fallback ONLY — used when no WalletTopupConfig row exists yet (before an
// admin ever saves one via phool-gobhi-admin's Settings page). The real,
// enforced values live in the WalletTopupConfig table — see
// walletService.js's getWalletTopupConfig. Matches the platform's original
// hardcoded behavior exactly, so a fresh deploy with no row yet behaves
// identically to before this became configurable.
export const DEFAULT_WALLET_TOPUP_CONFIG = {
  presets: [200, 500, 1000, 2000],
  allowCustomAmount: false,
  minCustomAmount: null,
  maxCustomAmount: null,
};

// Hard ceiling nobody — not even an admin — can raise via the API; only a
// redeploy can. Bounds the blast radius of a fat-fingered admin edit to one
// transaction and stays comfortably under typical early-KYC-tier Razorpay
// per-order limits.
export const HARD_MAX_TOPUP_AMOUNT = 25000;
