import { Router } from 'express';

// Coach content (exercise instructions, articles). Empty on purpose: A2 lands
// the mount point so B-tasks can add routes here without touching health.js
// again.
const router = Router();

export default router;
