// A transactional in-memory Prisma substitute, following auth-service's module-mock pattern.
// This exercises service/HTTP behavior, not PostgreSQL isolation or SQL constraints.
export function memoryDb() {
  let tables=Object.fromEntries(['exploreCatalogue','exploreEpochManifest','exploreProgress','exploreLocationReceipt','exploreRewardReceipt','exploreClaim','appVersionSetting'].map(n=>[n,[]]));
  let tail=Promise.resolve(),failure=null;
  const keyFields={exploreCatalogue:['version'],exploreEpochManifest:['epochManifestId'],exploreProgress:['userId'],exploreLocationReceipt:['receiptId'],exploreRewardReceipt:['receiptId'],exploreClaim:['userId','claimId'],appVersionSetting:['id']};
  const matches=(row,where={})=>Object.entries(where).every(([k,v])=>{
    if (v&&typeof v==='object'&&!(v instanceof Date)) {
      if ('lte' in v) return row[k]<=v.lte;
      return matches(row,v); // Prisma compound key
    }
    return row[k]===v;
  });
  const db={};
  for (const name of Object.keys(tables)) db[name]={
    async findUnique({where}) {return structuredClone(tables[name].find(r=>matches(r,where))??null);},
    async findMany({where}={}) {return structuredClone(tables[name].filter(r=>matches(r,where)));},
    async create({data}) {
      if (failure===name) {failure=null;throw Object.assign(new Error('simulated storage failure'),{code:'P1001'});}
      const keys=keyFields[name];
      if (tables[name].some(r=>keys.every(k=>r[k]===data[k]))) throw Object.assign(new Error('unique'),{code:'P2002'});
      tables[name].push(structuredClone(data));return structuredClone(data);
    },
    async createMany({data,skipDuplicates}) {
      for (const row of data) {
        const keys=name==='exploreEpochManifest'?['epoch','worldGeneration']:keyFields[name];
        if (tables[name].some(r=>keys.every(k=>r[k]===row[k]))) {
          if (skipDuplicates) continue;
          throw Object.assign(new Error('unique'),{code:'P2002'});
        }
        await db[name].create({data:row});
      }
    },
    async update({where,data}) {const r=tables[name].find(r=>matches(r,where));Object.assign(r,structuredClone(data));return structuredClone(r);},
  };
  db.$queryRaw=async()=>[];
  db.$transaction=async fn=>{
    const before=tail;let release;tail=new Promise(r=>{release=r;});await before;
    const snapshot=structuredClone(tables);
    try {return await fn(db);} catch(err) {tables=snapshot;throw err;} finally {release();}
  };
  db.inspect=()=>structuredClone(tables);
  db.failNext=name=>{failure=name;};
  return db;
}
