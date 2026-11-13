// Express cannot OR two gate arrays: a route gets one middleware chain, and
// the first middleware that rejects ends the request. The coach journey needs
// exactly that OR — the plan and score routes must stay reachable under the
// old nutrition consent (for users who granted it before the journey existed)
// AND under the new coachJourney flag plus the coach `basic` scope (for users
// who never open the food ledger). Without this helper the only options are
// duplicating every route or weakening the gates for everyone.
//
// How it decides:
//   - Gate A runs first, in full, against a CAPTURED response. If every
//     middleware in A calls next(), the request proceeds and B never runs.
//   - If any middleware in A would reject — res.status(...).json(...), or
//     next(err) — gate B runs the same way, against the same request.
//   - If B completes, the request proceeds.
//   - If both reject, only B's rejection is sent.
//
// The order is semantic, not cosmetic: the gate the client must KEEP seeing
// when everything refuses goes SECOND, because B's rejection is the one
// that is sent. Every either-gated route here puts the NEW gate (coach flag
// + scope) first and the OLD gate second, so with the coachJourney flag off
// the client gets exactly today's error — nutrition's CONSENT_REQUIRED, or
// the old flag's FEATURE_DISABLED — and never the coach gate's. The new
// gate failing fast at its flag check also means the flag-off path costs no
// consent query at all.
//
// The capture is a small fake res, not the real one: a gate that rejects must
// not write anything the caller can see. The gates in this service reject
// with res.status(code).json(body), so that pair is what carries the bytes;
// the other response methods are covered so a gate that evolves a new way of
// refusing still ends the run as a rejection instead of hanging it.

function runGate(middlewares, req) {
  return new Promise((resolve) => {
    const captured = { done: false, passed: false, status: null, body: null };
    const settle = (passed) => {
      if (captured.done) return;
      captured.done = true;
      captured.passed = passed;
      resolve(captured);
    };
    const fakeRes = {
      status(code) {
        captured.status = code;
        return fakeRes;
      },
      json(body) {
        captured.body = body;
        settle(false);
        return fakeRes;
      },
      send(body) {
        captured.body = body;
        settle(false);
        return fakeRes;
      },
      sendStatus(code) {
        captured.status = code;
        settle(false);
        return fakeRes;
      },
      end() {
        settle(false);
        return fakeRes;
      },
      setHeader() {
        return fakeRes;
      },
      set() {
        return fakeRes;
      },
      type() {
        return fakeRes;
      },
    };
    let index = -1;
    const next = (err) => {
      if (captured.done) return;
      if (err === 'route') {
        // Express's "skip to the next route" — not this helper's call to
        // interpret, so it is passed through unchanged.
        settle(true);
        return;
      }
      if (err) {
        // next(err) is Express's error exit. Treated as a rejection so gate
        // B still gets its chance; none of this service's gates use it, but
        // a middleware that throws mid-chain must not hang the request.
        captured.status = Number.isInteger(err?.status) ? err.status : 500;
        captured.body = { error: err?.message || 'Server error' };
        settle(false);
        return;
      }
      index += 1;
      if (index >= middlewares.length) {
        settle(true);
        return;
      }
      try {
        const out = middlewares[index](req, fakeRes, next);
        if (out && typeof out.then === 'function') {
          out.catch((asyncErr) => {
            if (captured.done) return;
            captured.status = 500;
            captured.body = { error: asyncErr?.message || 'Server error' };
            settle(false);
          });
        }
      } catch (err) {
        captured.status = 500;
        captured.body = { error: err?.message || 'Server error' };
        settle(false);
      }
    };
    next();
  });
}

/**
 * Accept the request if either gate's middlewares all pass.
 *
 * @param {Array|Function} gateA - tried first; its rejection is never sent.
 * @param {Array|Function} gateB - tried second; its rejection is the one the
 *   client sees when both fail.
 */
export function anyOf(gateA, gateB) {
  const a = Array.isArray(gateA) ? gateA : [gateA];
  const b = Array.isArray(gateB) ? gateB : [gateB];
  return (req, res, next) => {
    runGate(a, req)
      .then((fromA) => {
        if (fromA.passed) return next();
        return runGate(b, req).then((fromB) => {
          if (fromB.passed) return next();
          // Both rejected. B's status/body were captured, not sent; sending
          // them here is the one write this helper ever makes.
          return res.status(fromB.status ?? 403).json(fromB.body ?? { error: 'Forbidden' });
        });
      })
      .catch(() => {
        // The runners resolve rather than reject, so this is belt-and-braces:
        // a bug inside a gate must never 500 a route the gate is guarding.
        res.status(500).json({ error: 'Server error' });
      });
  };
}
