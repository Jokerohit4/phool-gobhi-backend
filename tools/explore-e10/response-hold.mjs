// Harness only: called after the router has obtained its committed result.
export function createPostCommitResponseHold() {
  let armed = false, pending;
  return {
    arm() {
      if (armed || pending) throw new Error('Response hold is already armed or pending');
      armed = true;
    },
    get armed() { return armed; },
    get pending() { return typeof pending === 'function'; },
    middleware(req, res, next) {
      const json = res.json.bind(res);
      res.json = body => {
        // req.path is mount-relative inside /explore; originalUrl stays stable.
        if (armed && req.originalUrl === '/explore/pickups' && body.data?.result === 'saved') {
          armed = false;
          pending = () => { if (!res.destroyed) json(body); };
          return res;
        }
        return json(body);
      };
      next();
    },
    release() {
      armed = false;
      const send = pending;
      pending = undefined;
      send?.();
    },
  };
}
