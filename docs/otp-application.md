# OTP Delivery — Cost Investigation & DLT Registration Reference

Status as of 2026-07-08: Fast2SMS `route=otp` is live in prod (auth-service). Cost is unchanged from before (~₹5/OTP). DLT registration is the only real path to a cheap per-SMS rate; not yet started.

## Background

`services/auth-service/services/authService.js` sends OTP via WhatsApp Cloud API first (not configured — no Meta integration), falling back to Fast2SMS SMS. WhatsApp was ruled out as a primary channel since not all customers have WhatsApp. Firebase Phone Auth was considered and set aside for now (different integration model — client-side SDK verification instead of the current server-side OTP-store approach).

## Cost investigation timeline

1. **Found:** Every OTP was costing ~₹5, traced to Fast2SMS `route=q` ("Quick SMS") — a route that skips DLT registration by using international connectivity.
2. **Hypothesis:** Switch to `route=otp` (also DLT-free, per Fast2SMS docs), expecting a lower rate.
3. **Changed:** `authService.js` `sendFast2SmsOtp()` now uses `route=otp` with `variables_values={code}` instead of `route=q` with a custom `message`. Deployed to prod (`main` branch, commit "Switch Fast2SMS OTP delivery to OTP route (no DLT required)").
4. **Verified live:** sent test OTP to a real number via prod gateway. SMS delivered successfully, but as a **fixed generic template** (`"<code> is your verification code"` — no "Phool Gobhi" branding, since custom text isn't allowed on this route).
5. **Result: cost unchanged.** Checked Fast2SMS billing — still ₹5 per OTP. Fast2SMS's own docs confirm the Quick route price (₹5) is **flat, "irrespective of your bulk SMS plan"** — this is not route-specific pricing, it's the going rate for *any* route that bypasses DLT. Switching between their two non-DLT routes only changes the message format, not the cost.

## Why no non-DLT route is meaningfully cheaper

Checked Fast2SMS, 2Factor, and general market data:
- The industry-wide cheap SMS rate (₹0.10–₹0.30/SMS) is consistently gated behind **DLT compliance** — no provider found offers that rate without it.
- Non-DLT "bypass" routes (whatever they're branded as — Quick, OTP-route, international-route) all sit in a ₹3–5+ premium band, because they're paying for international/workaround routing, not a technical shortcut.
- This is also a compliance risk, not just a cost one — TRAI can fine non-compliant senders and increasingly filters/blocks unregistered routes. Not a stable long-term foundation.

**Voice OTP** (call-based, reads code aloud) was surfaced as a genuinely different and cheaper option — ₹0.45–0.60/call via providers like Exotel/Way2Smart/MessageBot, no DLT required since DLT only governs SMS templates. Not yet pursued; would require a UX change (phone call instead of SMS) and a new provider integration. Missed-call verification (even cheaper) was considered but ruled out for now since it's typically sold as a monthly plan, not pay-per-use — not worth it pre-launch with no volume yet.

## DLT registration reference (Jio TrueConnect)

Chosen as the real long-term fix. Not yet started as of this doc.

- **Fee:** ₹5,900 (incl. 18% GST), one-time at entity registration, renewed annually.
- **Timeline:** Entity approval ~15 min–72 hours depending on document completeness; Header (Sender ID) + Template approval takes another 24–48 hours after that.
- **Documents needed for Principal Entity registration:**
  1. PAN card (business PAN if incorporated, personal PAN if not — sources disagree on whether personal PAN alone is sufficient without further business proof)
  2. Proof of business existence — any *one* of: GST certificate, MSME/Udyam certificate, Shop & Establishment license, TAN, or incorporation/MOA
  3. Government ID of the authorized signatory (Aadhaar recommended)
  4. Letter of Authorization (LOA) — signed declaration naming the authorized person, ideally on letterhead
  5. Email + phone number for the account
- **Then:** Header (6-char Sender ID, suffixed `-T`/`-P`/`-S` by type) + Template (exact OTP wording with `{#var#}` placeholder, brand name required) registration.
- **Fastest unlock if no GST/incorporation yet:** Udyam (MSME) registration is free and takes ~15–30 min online at udyamregistration.gov.in, using just Aadhaar + PAN — no company incorporation needed. Likely satisfies document #2 above.

## Open items

- [ ] Decide: pursue Udyam registration (if not already registered) → Jio DLT entity registration → Header + Template approval → switch `authService.js` back to a DLT-compliant route with the branded message.
- [ ] Alternative to revisit: Voice OTP integration (Exotel/Way2Smart) as a cheaper stopgap without waiting on DLT.
- [ ] Once DLT is live, restore the branded OTP message text (currently lost on the DLT-free route).
- [ ] Current prod code (`route=otp`) is a known temporary state — cost is not reduced, only the message format changed. No further action needed on the code until DLT is ready.
