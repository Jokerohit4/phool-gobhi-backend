"""Read-only deployed config and aggregate inventory; never prints secrets or photo paths."""
import subprocess, json, os, shutil
from pathlib import Path

# gcloud is gcloud.cmd on Windows and gcloud elsewhere.
GCLOUD = shutil.which('gcloud') or shutil.which('gcloud.cmd') or 'gcloud'

def cloud(args):
 r = subprocess.run([GCLOUD, *args, '--project=phool-gobhi', '--format=json'],capture_output=True,text=True)
 if r.returncode: raise RuntimeError('Cloud read unavailable')
 return json.loads(r.stdout)
for environment in ['dev','prod']:
 try:
  service=cloud(['run','services','describe','health-service-'+environment,'--region=asia-south1'])
  container=service['spec']['template']['spec']['containers'][0]
  entries=container.get('env',[])
  values={e['name']:e.get('value') for e in entries if 'value' in e}
  ref=next(e['valueFrom']['secretKeyRef'] for e in entries if e['name']=='SECRETS_JSON')
  r=subprocess.run([GCLOUD,'secrets','versions','access',ref['key'],'--secret='+ref['name'],'--project=phool-gobhi'],capture_output=True,text=True)
  if r.returncode: raise RuntimeError('Secret read unavailable')
  values.update(json.loads(r.stdout))
  candidates=json.loads(values.get('FOOD_PHOTO_PROVIDER_CANDIDATES') or '[]')
  print(json.dumps({'environment':environment,'revision':service['status']['latestReadyRevisionName'],'primaryModel':values.get('FOOD_PHOTO_PROVIDER_MODEL'),'keyConfigured':bool(values.get('FOOD_PHOTO_PROVIDER_API_KEY')),'rotation':[{'provider':c.get('provider'),'model':c.get('model'),'keyConfigured':bool(c.get('apiKey'))} for c in candidates],'optimisations':{k:v for k,v in values.items() if k in ['FOOD_PHOTO_NUTRITION_MODE','FOOD_PHOTO_SHORTLIST','FOOD_PHOTO_LOW_RESOLUTION','FOOD_PHOTO_THINKING','FOOD_PHOTO_EXACT_CACHE','FOOD_PHOTO_CONTRIBUTIONS']}}))
  code = """import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL});
try { await c.connect(); await c.query('BEGIN READ ONLY');
const queries={requests:`SELECT model,outcome,count(*) FROM health."FoodPhotoRequestLog" WHERE "requestedAt">now()-interval '30 days' GROUP BY 1,2`,catalogue:`SELECT verified,("createdByUserId" IS NULL) AS shared,count(*) FROM health."FoodItem" GROUP BY 1,2`,photos:`SELECT count(*) AS logs,count(DISTINCT "userId") AS people,count(DISTINCT "photoPath") AS photos FROM health."FoodLog" WHERE "photoPath" IS NOT NULL`,topFoods:`SELECT f.name,count(*) AS logs,count(DISTINCT l."userId") AS people FROM health."FoodLog" l JOIN health."FoodItem" f ON f.id=l."foodItemId" GROUP BY f.name ORDER BY logs DESC LIMIT 50`,photosPerFood:`SELECT f.name,(f."createdByUserId" IS NULL) AS shared,f.verified,count(*) AS photos,count(DISTINCT l."userId") AS people,sum(CASE WHEN l."photoCorrections">0 THEN 1 ELSE 0 END) AS corrected FROM health."FoodLog" l JOIN health."FoodItem" f ON f.id=l."foodItemId" WHERE l."photoPath" IS NOT NULL GROUP BY 1,2,3 ORDER BY photos DESC`};
for(const [name,sql] of Object.entries(queries)) console.log(JSON.stringify({name,rows:(await c.query(sql)).rows})); await c.query('ROLLBACK');
} catch {console.log(JSON.stringify({inventory:'unavailable'}));process.exitCode=1;} finally {await c.end();}"""
  env=os.environ.copy();env['DATABASE_URL']=values.get('DATABASE_URL','')
  r=subprocess.run(['node','--input-type=module','-'],input=code,capture_output=True,text=True,env=env,cwd=Path(__file__).resolve().parents[1])
  print(r.stdout)
 except Exception:
  print(json.dumps({'environment':environment,'verification':'unavailable'}))
