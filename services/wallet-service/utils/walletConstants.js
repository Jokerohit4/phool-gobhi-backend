// Single source of truth for the wallet top-up preset restriction — mirrors
// phool-gobhi-website's lib/walletConstants.ts. This is the layer that
// actually enforces it: any client (website, apps, or a raw API call) hits
// this same check, so the restriction can't be bypassed by skipping a
// particular client's UI.
export const WALLET_TOPUP_AMOUNTS = [200, 500, 1000, 2000];
