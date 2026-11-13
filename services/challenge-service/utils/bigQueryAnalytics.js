// Compatibility adapter for the audited analytics report SQL, not a general SQL
// translator. Every supported query shape is dry-run and compared during migration.
import { GoogleAuth } from 'google-auth-library';
import { PROPERTY_KEYS, analyticsEnvironment } from './analyticsTransport.js';
const properties = new Set(PROPERTY_KEYS);
const auth = new GoogleAuth({ projectId: 'phool-gobhi', scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
let authClient;
const cache = new Map();

function argumentStart(sql, end) {
  let position = end;
  while (/\s/.test(sql[position] || '') && position >= 0) position--;
  if (sql[position] === ')') {
    let depth = 1;
    while (position > 0 && depth > 0) {
      position--;
      if (sql[position] === ')') depth++;
      else if (sql[position] === '(') depth--;
    }
    while (position > 0 && /[A-Za-z0-9_]/.test(sql[position - 1])) position--;
    return position;
  }
  while (position >= 0 && /[\w.@]/.test(sql[position])) position--;
  return position + 1;
}

function matchingParen(sql, start) {
  let depth = 0, quote = false;
  for (let index = start; index < sql.length; index++) {
    if (sql[index] === "'" && sql[index - 1] !== '\\') {
      if (quote && sql[index + 1] === "'") { index++; continue; }
      quote = !quote;
    }
    if (quote) continue;
    if (sql[index] === '(') depth++;
    if (sql[index] === ')' && --depth === 0) return index;
  }
  throw Error('unbalanced audited analytics expression');
}

function castExpressions(sql) {
  const types = { int: 'INT64', integer: 'INT64', bigint: 'INT64', numeric: 'NUMERIC', float: 'FLOAT64', float8: 'FLOAT64', text: 'STRING', date: 'DATE' };
  for (let count = 0; count < 200; count++) {
    const match = /::(int|integer|bigint|numeric|float8|float|text|date)\b/i.exec(sql);
    if (!match) return sql;
    const start = argumentStart(sql, match.index - 1);
    const expression = sql.slice(start, match.index);
    sql = sql.slice(0, start) + `CAST(${expression} AS ${types[match[1].toLowerCase()]})` + sql.slice(match.index + match[0].length);
  }
  throw Error('too many analytics casts');
}

function aggregateFilters(sql) {
  let search = 0;
  for (let count = 0; count < 100; count++) {
    const match = /\b(count|sum|array_agg)\s*\(/ig;
    match.lastIndex = search;
    const found = match.exec(sql);
    if (!found) break;
    const open = sql.indexOf('(', found.index), close = matchingParen(sql, open);
    const filter = /^\s*FILTER\s*\(\s*WHERE\s+/i.exec(sql.slice(close + 1));
    if (!filter) { search = close + 1; continue; }
    const filterOpen = sql.indexOf('(', close + 1), filterClose = matchingParen(sql, filterOpen);
    const condition = sql.slice(close + 1 + filter[0].length, filterClose);
    const value = sql.slice(open + 1, close), fn = found[1].toLowerCase();
    let replacement;
    let after = filterClose + 1;
    if (fn === 'array_agg') {
      const ordered = value.match(/^([\s\S]+?)\s+ORDER BY\s+([\s\S]+)$/i);
      if (!ordered) throw Error('unsupported analytics ordered aggregate');
      replacement = `ARRAY_AGG(IF(${condition}, ${ordered[1]}, NULL) IGNORE NULLS ORDER BY ${ordered[2]} LIMIT 1)[SAFE_OFFSET(0)]`;
      // The PostgreSQL expression wraps the aggregate before selecting element 1.
      if (sql[found.index - 1] === '(' && /^\)\[1\]/.test(sql.slice(after))) {
        sql = sql.slice(0, found.index - 1) + replacement + sql.slice(after + 4);
        search = found.index - 1 + replacement.length;
        continue;
      }
    } else if (fn === 'count' && value.trim() === '*') replacement = `COUNTIF(${condition})`;
    else if (fn === 'count' && /^DISTINCT\s+/i.test(value)) replacement = `COUNT(DISTINCT IF(${condition},${value.replace(/^DISTINCT\s+/i, '')},NULL))`;
    else replacement = `${fn}(IF(${condition},${value},NULL))`;
    sql = sql.slice(0, found.index) + replacement + sql.slice(after);
    search = found.index + replacement.length;
  }
  return sql;
}

function firstArrayElements(sql) {
  let search=0;
  for(let count=0;count<100;count++) {
    const pattern=/\barray_agg\s*\(/ig;pattern.lastIndex=search;const found=pattern.exec(sql);
    if(!found)break;
    const open=sql.indexOf('(',found.index),close=matchingParen(sql,open);
    if(sql[found.index-1]==='(' && /^\)\[1\]/.test(sql.slice(close+1))) {
      const value=sql.slice(open+1,close);
      const replacement=`ARRAY_AGG(${value} LIMIT 1)[SAFE_OFFSET(0)]`;
      sql=sql.slice(0,found.index-1)+replacement+sql.slice(close+5);
      search=found.index-1+replacement.length;
    } else search=close+1;
  }
  return sql;
}

export function compileAnalyticsQuery(original, values = [], { project = process.env.ANALYTICS_BIGQUERY_PROJECT || 'phool-gobhi',
  dataset = process.env.ANALYTICS_BIGQUERY_DATASET || 'analytics_' + analyticsEnvironment(), asOf = new Date() } = {}) {
  if (!/^[a-z][a-z0-9-]+$/.test(project) || !/^analytics_(dev|prod)$/.test(dataset)) throw Error('invalid analytics warehouse identifier');
  const parameters = values.map((value, index) => ({ name: 'p' + (index + 1),
    parameterType: Array.isArray(value) ? {type:'ARRAY',arrayType:{type:'STRING'}} : {type: typeof value === 'number' ? (Number.isInteger(value) ? 'INT64' : 'FLOAT64') : 'STRING'},
    parameterValue: Array.isArray(value) ? {arrayValues:value.map(item=>({value:String(item)}))} : {value:value == null ? null : String(value)} }));
  const asof = typeof asOf==='string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(asOf) ? asOf : new Date(asOf).toISOString();
  const sourceCount = (original.match(/\banalytics_events\b/g) || []).length;
  let scanDays = null;
  if (sourceCount === 1 || /WITH\s+step0\s+AS/i.test(original)) {
    const dynamic = original.match(/now\(\)\s*-\s*\(\$(\d+)\s*\|\|\s*' (days|weeks)'\)::interval/i);
    const fixed = original.match(/now\(\)\s*-\s*interval\s*'(\d+) (days|weeks)'/i);
    if (dynamic) scanDays = Number(values[Number(dynamic[1])-1]) * (dynamic[2] === 'weeks' ? 7 : 1);
    else if (fixed) scanDays = Number(fixed[1]) * (fixed[2] === 'weeks' ? 7 : 1);
  }
  if (scanDays !== null && !(scanDays > 0)) throw Error('invalid analytics scan window');
  const eventClauses = [...original.matchAll(/\b(?:WHERE|AND|ON)\s+(?:\w+\.)?event\s*(?:=\s*ANY\(\$(\d+)\)|=\s*\$(\d+)|=\s*'([^']+)'|IN\s*\(([^)]+)\))/gi)];
  const events = eventClauses.length >= sourceCount ? [...new Set(eventClauses.flatMap(match => {
    if (match[1]) return values[Number(match[1])-1];
    if (match[2]) return [values[Number(match[2])-1]];
    if (match[3]) return [match[3]];
    return [...match[4].matchAll(/'([^']+)'/g)].map(value=>value[1]);
  }))] : [];
  parameters.push({name:'as_of',parameterType:{type:'TIMESTAMP'},parameterValue:{value:asof}},
    {name:'scan_since',parameterType:{type:'TIMESTAMP'},parameterValue:{value:scanDays === null ? '1970-01-01T00:00:00Z' : new Date(Date.parse(asof)-scanDays*86400000).toISOString()}},
    {name:'event_names',parameterType:{type:'ARRAY',arrayType:{type:'STRING'}},parameterValue:{arrayValues:events.map(value=>({value:String(value)}))}});
  let sql = original;
  if (/percentile_cont/i.test(sql)) {
    if (!/percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY \(properties->>'nearest_gym_distance_km'\)::numeric\)::float AS median_km/i.test(sql)) {
      throw Error('unsupported analytics percentile shape');
    }
    const tail = sql.slice(sql.indexOf('FROM analytics_events'));
    sql = `SELECT count(*)::int AS n, avg((properties->>'nearest_gym_distance_km')::numeric)::float AS avg_km,
      max(__median)::float AS median_km FROM (SELECT *,
      PERCENTILE_CONT(CAST(JSON_VALUE(properties,'$.nearest_gym_distance_km') AS NUMERIC),0.5) OVER() AS __median ${tail})`;
  }
  // Constant and user-selected JSON keys are values, never interpolated SQL identifiers.
  sql = sql.replace(/(\b\w+\.)?properties\s*->>\s*('([^']+)'|\$(\d+))/g, (_all, prefix = '', _operand, literal, number) => {
    const key = literal ?? String(values[Number(number) - 1]);
    if (properties.has(key)) return prefix + 'p_' + key;
    const name = 'json_path_' + parameters.length;
    parameters.push({name,parameterType:{type:'STRING'},parameterValue:{value:'$.' + JSON.stringify(key)}});
    return `JSON_VALUE(${prefix}properties,@${name})`;
  });
  sql = sql.replace(/\$(\d+)/g, '@p$1').replace(/\bnow\(\)/gi, '@as_of');
  sql = sql.replace(/=\s*ANY\((@p\d+)\)/gi, 'IN UNNEST($1)');
  sql = sql.replace(/\bdate_trunc\s*\(\s*'(day|week|month)'\s*,/gi, (_all, unit) => `__TRUNC_${unit.toUpperCase()}__(`);
  for (const unit of ['DAY','WEEK','MONTH']) {
    const marker = '__TRUNC_' + unit + '__(';
    while (sql.includes(marker)) {
      const start = sql.indexOf(marker), open = start + marker.length - 1, close = matchingParen(sql, open);
      sql = sql.slice(0, start) + `TIMESTAMP_TRUNC(${sql.slice(open + 1, close)},${unit === 'WEEK' ? 'WEEK(MONDAY)' : unit})` + sql.slice(close + 1);
    }
  }
  sql = sql.replace(/EXTRACT\(EPOCH FROM\s*\(([\w.]+)\s*-\s*([\w.]+)\)\)/gi, '(TIMESTAMP_DIFF($1,$2,MICROSECOND)/1000000.0)');
  sql = sql.replace(/@as_of\s*-\s*\((@p\d+)\s*\|\|\s*' (days|weeks)'\)::interval/gi,
    (_all, parameter, unit) => `TIMESTAMP_SUB(@as_of,INTERVAL CAST(ROUND(${parameter}*${unit === 'weeks' ? 604800000000 : 86400000000}) AS INT64) MICROSECOND)`);
  sql = sql.replace(/@as_of\s*-\s*interval\s*'(\d+)\s+(day|week|hour|minute)s?'/gi,
    (_all, amount, unit) => `TIMESTAMP_SUB(@as_of,INTERVAL ${amount} ${unit.toUpperCase()})`);
  sql = sql.replace(/SELECT DISTINCT ON \(([^)]+)\)([\s\S]*?)ORDER BY\s*\1,\s*ts DESC/gi,
    (_all, key, body) => `SELECT ${body} QUALIFY ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ts DESC)=1`);
  sql = aggregateFilters(sql);
  sql = firstArrayElements(sql);
  sql = sql.replace(/SELECT DISTINCT jsonb_object_keys\(properties\) AS key\s+FROM analytics_events/gi,
    'SELECT DISTINCT key FROM analytics_events, UNNEST(JSON_KEYS(PARSE_JSON(properties),1)) AS key');
  sql = castExpressions(sql);
  sql = sql.replace(/distinct_id LIKE 'anon\\?_%'/gi, "STARTS_WITH(distinct_id,'anon_')");
  sql = sql.replace(/\banalytics_events\b/g, `\`${project}.${dataset}.events_between\`(@scan_since,@as_of,@event_names)`);
  if (/::|->>|\bFILTER\s*\(|\bDISTINCT ON\b|\bjsonb_|\binterval\s*'/i.test(sql)) throw Error('unsupported analytics SQL; migration parity gate required');
  return { query: sql, queryParameters: parameters };
}

export function decodeQueryRows(response) {
  const fields = response.schema?.fields || [];
  return (response.rows || []).map(row => Object.fromEntries(fields.map((field, index) => {
    const value = row.f[index]?.v;
    let decoded = value;
    if (value == null) decoded = null;
    else if (['INTEGER','INT64','FLOAT','FLOAT64','NUMERIC','BIGNUMERIC'].includes(field.type)) decoded = Number(value);
    else if (field.type === 'TIMESTAMP') decoded = new Date(Number(value) * 1000);
    else if (field.type === 'DATE') decoded = new Date(value+'T00:00:00Z');
    else if (field.name === 'properties' && typeof value === 'string') decoded = JSON.parse(value);
    else if (field.type === 'BOOLEAN') decoded = value === 'true' || value === true;
    return [field.name, decoded];
  })));
}

export async function queryBigQuery(sql, params = [], options = {}) {
  const project = options.project || process.env.ANALYTICS_BIGQUERY_PROJECT || 'phool-gobhi';
  const location = process.env.ANALYTICS_BIGQUERY_LOCATION || 'asia-south1';
  const asOf = options.asOf || new Date(Math.floor(Date.now()/60000)*60000);
  const compiled = options.native ? {query:sql,queryParameters:options.queryParameters || []} : compileAnalyticsQuery(sql, params, {...options, project, asOf});
  const key = JSON.stringify(compiled);
  const cached = cache.get(key);
  if (!options.dryRun && !options.client && cached && Date.now()-cached.at < 60000) return cached.result;
  const client = options.client || await (authClient ||= auth.getClient());
  if (options.dryRun) return (await client.request({url:`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs`,method:'POST',timeout:20000,
    data:{jobReference:{projectId:project,location},configuration:{dryRun:true,query:{...compiled,useLegacySql:false,parameterMode:'NAMED',
      maximumBytesBilled:String(process.env.ANALYTICS_MAX_BYTES_BILLED || 268435456)}}}})).data;
  let result = (await client.request({url:`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,method:'POST',timeout:20000,
    data:{...compiled,useLegacySql:false,parameterMode:'NAMED',location,timeoutMs:10000,useQueryCache:true,
      maximumBytesBilled:String(process.env.ANALYTICS_MAX_BYTES_BILLED || 268435456)}})).data;
  const deadline = Date.now()+15000;
  while (!result.jobComplete && Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,250));
    result = (await client.request({url:`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${result.jobReference.jobId}?location=${location}&timeoutMs=1000`,timeout:3000})).data;
  }
  if (!result.jobComplete || result.errors?.length) throw Error('analytics warehouse query incomplete');
  const rows = decodeQueryRows(result);
  const fields = result.schema?.fields || [];
  const job = result.jobReference;
  let pageToken = result.pageToken;
  while (pageToken) {
    if (Date.now()>deadline) throw Error('analytics result pagination deadline exceeded');
    const page=(await client.request({url:`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${job.jobId}?location=${location}&pageToken=${encodeURIComponent(pageToken)}`,timeout:5000})).data;
    if(page.errors?.length) throw Error('analytics result page failed');
    rows.push(...decodeQueryRows({...page,schema:{fields}}));
    pageToken=page.pageToken;
  }
  const output = { rows, fields:fields.map(field=>({name:field.name})), metadata:{processedBytes:Number(result.totalBytesProcessed || 0),cached:!!result.cacheHit} };
  if (!options.client) {
    if (cache.size>=200) cache.delete(cache.keys().next().value);
    cache.set(key,{at:Date.now(),result:output});
  }
  return output;
}
