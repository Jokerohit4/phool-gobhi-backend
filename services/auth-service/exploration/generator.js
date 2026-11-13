// Generator v1 ported from the frozen E0 reference. Keep IEEE-754 operation order.
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const windows = ['night','breakfast','lunch','evening','night'].map(pool => ({pool}));
function cell(lat,lng) {
  assert(Number.isFinite(lat) && Number.isFinite(lng));
  const row=Math.max(0,Math.min(35999,Math.floor((lat+90)/0.005)));
  const c=Math.floor((lng+180)/0.005);
  const col=((c % 72000) + 72000) % 72000;
  return {row,col};
}
function round6(x) {
  // Required Dart-double semantics. Do not replace with Math.round or epsilon.
  const y=x*1e6;
  const r=Math.trunc(y);
  return (Math.abs(y-r)>=0.5 ? r+Math.sign(y) : r)/1e6;
}
function pick(pool,u2) {
  assert(Number.isInteger(u2) && u2>=0 && u2<=0xffffffff);
  const totalWeight=pool.reduce((a,e)=>a+e.weight,0), t=u2%totalWeight;
  let sum=0;
  for(const e of pool) { sum+=e.weight; if(sum>t)return {totalWeight,t,itemKey:e.itemKey}; }
  throw Error('invalid pool');
}
function clock(utc) {
  // Fixed +05:30 is Asia/Kolkata for these modern pilot dates. Host TZ ignored.
  const d=new Date(Date.parse(utc)+330*60000), minute=d.getUTCHours()*60+d.getUTCMinutes();
  return {epoch:d.toISOString().slice(0,10).replaceAll('-',''),window:[360,660,960,1260,1440].findIndex(end=>minute<end)};
}
function generate(epoch,w,row,col,slot,cat) {
  assert(/^\d{8}$/.test(epoch));
  assert([w,row,col,slot].every(Number.isInteger));
  assert(w>=0&&w<5&&row>=0&&row<36000&&col>=0&&col<72000&&slot>=0&&slot<4);
  const seed=`pgff|1|${epoch}|${w}|${row}|${col}|${slot}`;
  const h=crypto.createHash('sha256').update(seed,'utf8').digest();
  const u=Array.from({length:5},(_,i)=>h.readUInt32BE(i*4));
  // Preserve operation order and IEEE-754 arithmetic used by Dart doubles.
  const latitude=round6(row*0.005-90+(u[0]/2**32)*0.005);
  const longitude=round6(col*0.005-180+(u[1]/2**32)*0.005);
  return {occurrenceId:`ff1_${epoch}_${w}_${row}_${col}_${slot}`,seed,sha256:h.toString('hex'),u,latitude,longitude,latitudeMicros:Math.round(latitude*1e6),longitudeMicros:Math.round(longitude*1e6),pick:pick(cat.windowPools[windows[w].pool],u[2]),golden:cat.goldenOneIn!==0&&u[4]%cat.goldenOneIn===0};
}
const earthRadiusMeters=6371000;
const radians=Math.PI/180;
function haversineMeters(latitude,longitude,targetLatitude,targetLongitude) {
  const dLat=(targetLatitude-latitude)*radians,dLng=(targetLongitude-longitude)*radians;
  const a=Math.sin(dLat/2)**2+Math.cos(latitude*radians)*Math.cos(targetLatitude*radians)*Math.sin(dLng/2)**2;
  return 2*earthRadiusMeters*Math.asin(Math.sqrt(Math.max(0,Math.min(1,a))));
}
function scanRadius({epoch,window,latitude,longitude,radiusMeters},cat) {
  assert(Number.isFinite(latitude)&&latitude>=-90&&latitude<=90);
  assert(Number.isFinite(longitude)&&longitude>=-180&&longitude<=180);
  assert(Number.isFinite(radiusMeters)&&radiusMeters>=0&&radiusMeters<=300);
  // Spherical-cap bounds, not an approximate meters-per-degree longitude box.
  // Expand by half a microdegree: a spawn can round across its nominal cell
  // edge. Only the final Haversine predicate decides inclusion, without epsilon.
  const angle=radiusMeters/earthRadiusMeters,latDelta=angle/radians,roundingMargin=0.0000005;
  const minLat=Math.max(-90,latitude-latDelta-roundingMargin);
  const maxLat=Math.min(90,latitude+latDelta+roundingMargin);
  const firstRow=cell(minLat,longitude).row,lastRow=cell(maxLat,longitude).row;
  const reachesPole=latitude-latDelta<=-90||latitude+latDelta>=90;
  const lngDelta=reachesPole?180:Math.asin(Math.min(1,Math.sin(angle)/Math.cos(latitude*radians)))/radians;
  const firstCol=Math.floor((longitude-lngDelta-roundingMargin+180)/0.005);
  const lastCol=Math.floor((longitude+lngDelta+roundingMargin+180)/0.005);
  const columnCount=Math.min(72000,lastCol-firstCol+1),found=[];
  for(let row=firstRow;row<=lastRow;row++)for(let offset=0;offset<columnCount;offset++) {
    const c=firstCol+offset,col=((c%72000)+72000)%72000;
    for(let slot=0;slot<4;slot++) {
      const spawn=generate(epoch,window,row,col,slot,cat);
      const distanceMeters=haversineMeters(latitude,longitude,spawn.latitude,spawn.longitude);
      if(distanceMeters<=radiusMeters)found.push({...spawn,distanceMeters});
    }
  }
  return found.sort((a,b)=>a.distanceMeters-b.distanceMeters||(a.occurrenceId<b.occurrenceId?-1:a.occurrenceId>b.occurrenceId?1:0));
}
function gridOccurrence(spawn,epoch,window) {
  const midnight=Date.UTC(Number(epoch.slice(0,4)),Number(epoch.slice(4,6))-1,Number(epoch.slice(6,8)))-330*60000;
  const bounds=[0,360,660,960,1260,1440],end=midnight+bounds[window+1]*60000;
  return {occurrenceId:spawn.occurrenceId,kind:'grid',anchor:null,itemKey:spawn.pick.itemKey,golden:spawn.golden,position:{latitude:spawn.latitude,longitude:spawn.longitude},window,startsAt:new Date(midnight+bounds[window]*60000).toISOString(),endsAt:new Date(end).toISOString(),uploadUntil:new Date(end+86400000).toISOString(),eligibility:'available',directedSuggestion:false};
}

export { cell, round6, pick, clock, generate, haversineMeters, scanRadius, gridOccurrence };
