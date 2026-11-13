import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generate } from './generator.js';

export const catalogueV1 = JSON.parse(readFileSync(new URL('./contract/catalogue-v1.json', import.meta.url), 'utf8'));
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = value => 'sha256:' + createHash('sha256').update(canonical(value), 'utf8').digest('hex');
const errors = {
  INVALID_REQUEST:[400,false], LOCATION_REQUIRED:[400,false], CURSOR_INVALID:[400,false],
  AUTH_REQUIRED:[401,false], FORBIDDEN:[403,false], FEATURE_DISABLED:[404,false], CATALOGUE_NOT_FOUND:[404,false],
  CATALOGUE_HASH_MISMATCH:[409,false], MANIFEST_UNPUBLISHED:[409,true], MANIFEST_MISMATCH:[409,false],
  IDEMPOTENCY_CONFLICT:[409,false], RATE_LIMITED:[429,true], INTERNAL_ERROR:[500,true], WORLD_UNAVAILABLE:[503,true],
};
export class ExploreError extends Error {
  constructor(code) { super(code); this.code = code; [this.status, this.retryable] = errors[code]; }
}
export function errorResponse(res, code, requestId = randomUUID()) {
  const [status,retryable] = errors[code];
  if (status === 429 || status === 503) res.set('Retry-After', '5');
  return res.status(status).json({error:{code,messageKey:'explore.error.'+code.toLowerCase(),retryable,requestId}});
}
export function requireExploreCustomer(req,res,next) {
  const id = req.headers['x-user-id'];
  if (!/^[1-9]\d*$/.test(id ?? '') || !Number.isSafeInteger(Number(id))) return errorResponse(res,'AUTH_REQUIRED');
  if (req.headers['x-user-role'] !== 'customer') return errorResponse(res,'FORBIDDEN');
  req.user = {id:Number(id),role:'customer'};
  next();
}
export const fail = code => { throw new ExploreError(code); };
export function queryKeys(query, allowed) {
  if (Object.keys(query).some(k=>!allowed.includes(k))) fail('INVALID_REQUEST');
}
export function integer(value, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!['string','number'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value))) fail('INVALID_REQUEST');
  const n=Number(value);
  if (!Number.isSafeInteger(n)||n<min||n>max) fail('INVALID_REQUEST');
  return n;
}
export const id = value => typeof value === 'string' && /^[\x20-\x7e]{1,128}$/.test(value);
export const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,19) === value.slice(0,19);
};
export function parseOccurrence(value) {
  const match = /^ff1_(\d{8})_(0|[1-9]\d*)_(0|[1-9]\d*)_(0|[1-9]\d*)_(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const [,epoch,w,r,c,s]=match;
  const date = `${epoch.slice(0,4)}-${epoch.slice(4,6)}-${epoch.slice(6,8)}T00:00:00Z`;
  if (!instant(date)) return null;
  const [window,row,col,slot]=[w,r,c,s].map(Number);
  if (window>4||row>35999||col>71999||slot>3) return null;
  return {epoch,window,row,col,slot,worldGeneration:1};
}
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
export function validateCommand(command) {
  if (!exactKeys(command,['claimId','occurrenceId','epochManifestId','startedAt','completedAt','position'])) fail('INVALID_REQUEST');
  if (![command.claimId,command.occurrenceId,command.epochManifestId].every(id) || ![command.startedAt,command.completedAt].every(instant)) fail('INVALID_REQUEST');
  if (command.occurrenceId.startsWith('ff1_') && !parseOccurrence(command.occurrenceId)) fail('INVALID_REQUEST');
  if (/^(breakthrough|tiffin):/.test(command.occurrenceId)) fail('INVALID_REQUEST');
  const p = command.position;
  if (!exactKeys(p,['latitude','longitude','accuracyMeters','speedMetersPerSecond','speedConfirmed','fixAt','capturedAt'])) fail('INVALID_REQUEST');
  if (![p.latitude,p.longitude,p.accuracyMeters].every(v=>typeof v==='number'&&Number.isFinite(v)) || Math.abs(p.latitude)>90 || Math.abs(p.longitude)>180 || p.accuracyMeters<0) fail('INVALID_REQUEST');
  if (p.speedMetersPerSecond!==null && (typeof p.speedMetersPerSecond!=='number'||!Number.isFinite(p.speedMetersPerSecond))) fail('INVALID_REQUEST');
  if (typeof p.speedConfirmed!=='boolean'||!instant(p.fixAt)||!instant(p.capturedAt)||Date.parse(p.capturedAt)!==Date.parse(command.startedAt)) fail('INVALID_REQUEST');
  return command;
}
export function windowBounds(epoch,window,windows=catalogueV1.windows) {
  const midnight=Date.parse(`${epoch.slice(0,4)}-${epoch.slice(4,6)}-${epoch.slice(6,8)}T00:00:00Z`)-330*60000;
  const minutes=s=>{const [h,m]=s.split(':').map(Number);return h*60+m;};
  return {begin:midnight+minutes(windows[window].start)*60000,end:midnight+minutes(windows[window].end)*60000};
}
// Also exposed for the contract's synthetic distance probes. Actual claims always recompute distance.
export function timingReason({startedAt,completedAt,fixAt,uploadedAt,accuracy=10,distance=0,speed=1,speedConfirmed=true}, {begin,end}) {
  const [s,c,f,upload]=[startedAt,completedAt,fixAt,uploadedAt].map(Date.parse);
  if (!(begin<=s&&s<end)) return 'START_OUTSIDE_WINDOW';
  if (!(0<=s-f&&s-f<=30000)) return 'FIX_STALE';
  if (!(0<=accuracy&&accuracy<=30)) return 'FIX_INACCURATE';
  if (distance>40) return 'OUTSIDE_GEOFENCE';
  if (speed===null||speed<0||!speedConfirmed) return 'SPEED_UNCONFIRMED';
  if (speed>4) return 'MOVING_TOO_FAST';
  if (c<s) return 'INVALID_TIMESTAMPS';
  if (c-s>60000) return 'ENCOUNTER_TOO_LONG';
  if (upload<c) return 'INVALID_TIMESTAMPS';
  if (upload>end+86400000) return 'UPLOAD_EXPIRED';
  return null;
}
export function resolveGrid(parsed, manifest, cat) {
  const {epoch,window,row,col,slot} = parsed;
  if (manifest.generatorVersion!==1 || manifest.timezone!=='Asia/Kolkata' || manifest.catalogueHash!==cat.contentHash || manifest.catalogueVersion!==cat.catalogueVersion || hash(cat.dropConfiguration)!==manifest.dropRegionHash || cat.dropConfiguration.version!==manifest.dropRegionVersion || canonical(cat.windows)!==canonical(manifest.windows) || manifest.goldenOneIn!==cat.goldenOneIn) fail('WORLD_UNAVAILABLE');
  return generate(epoch,window,row,col,slot,cat);
}
export const noDelta = () => ({addedReceiptIds:[],newVarietyKeys:[],newMilestones:[],dailySetEpoch:null});
export function summary(receipts,revision) {
  const keys=new Set(receipts.map(r=>r.itemKey));
  const core=catalogueV1.items.filter(i=>keys.has(i.itemKey)).length;
  const location=receipts.filter(r=>r.source==='location').length;
  return {revision,savedFindCount:receipts.length,locationFindCount:location,rewardFindCount:receipts.length-location,varietyCount:keys.size,coreVarietyCount:core,coreVarietyTotal:12,goldenFindCount:receipts.filter(r=>r.golden).length,milestones:[...(receipts.length?['first_find']:[]),...(keys.size>=3?['three_varieties']:[]),...(core===12?['twelve_core_varieties']:[])],dailySet:null};
}
export function cursorCodec(secret) {
  const sign = body => { if (!secret) fail('WORLD_UNAVAILABLE'); return createHmac('sha256',secret).update(body).digest('base64url'); };
  return {
    encode(value) { const body=Buffer.from(JSON.stringify(value)).toString('base64url'); return body+'.'+sign(body); },
    decode(cursor,userId) {
      if (typeof cursor!=='string'||cursor.length>2048) fail('CURSOR_INVALID');
      const [body,sig,...extra]=cursor.split('.');
      if (!body||!sig||extra.length) fail('CURSOR_INVALID');
      const expected=Buffer.from(sign(body)),actual=Buffer.from(sig);
      if (expected.length!==actual.length||!timingSafeEqual(expected,actual)) fail('CURSOR_INVALID');
      let value; try { value=JSON.parse(Buffer.from(body,'base64url').toString()); } catch { fail('CURSOR_INVALID'); }
      if (value.userId!==userId||!Number.isSafeInteger(value.revision)||value.revision<0||!Number.isSafeInteger(value.offset)||value.offset<0||!instant(value.snapshotAt)) fail('CURSOR_INVALID');
      return value;
    },
  };
}
