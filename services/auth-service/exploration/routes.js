import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { createExploreService } from './service.js';
import { ExploreError, errorResponse, requireExploreCustomer } from './contracts.js';

export function createExploreRouter(service=createExploreService({db:new PrismaClient()})) {
  const router=Router();
  router.use(requireExploreCustomer);
  const handle=fn=>async(req,res)=>{
    try { res.json({data:await fn(req)}); }
    catch (err) {
      // Never log the request, error object or raw Prisma diagnostics: proofs are transient.
      const code=err instanceof ExploreError?err.code:(typeof err?.code === 'string' && err.code.startsWith('P'))?'WORLD_UNAVAILABLE':'INTERNAL_ERROR';
      errorResponse(res,code);
    }
  };
  router.get('/catalogue',handle(req=>service.catalogue(req.query)));
  router.get('/collection',handle(req=>service.collection(req.user.id,req.query)));
  router.get('/nearby',handle(req=>service.nearby(req.user.id,req.query,req.headers)));
  router.post('/pickups',handle(req=>service.pickup(req.user.id,req.body)));
  return router;
}
export default createExploreRouter();
