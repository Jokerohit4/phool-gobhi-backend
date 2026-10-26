// Native GoogleSQL for the five original investor reports; exact counts retained.
module.exports = {
 inventory:`SELECT event,service,source,COUNT(*) AS \`rows\`,COUNT(DISTINCT distinct_id) AS users,
 MIN(ts) AS first_ts,MAX(ts) AS last_ts FROM WAREHOUSE_EVENTS GROUP BY event,service,source ORDER BY \`rows\` DESC`,
 dau:`WITH days AS (SELECT d FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(DATE(@as_of),INTERVAL 29 DAY),DATE(@as_of))) d),
 per_day AS (SELECT d.d AS d,(SELECT COUNT(DISTINCT a.distinct_id) FROM WAREHOUSE_EVENTS a WHERE DATE(a.ts)=d.d AND a.distinct_id IS NOT NULL) AS dau FROM days d),
 mau AS (SELECT COUNT(DISTINCT distinct_id) AS users FROM WAREHOUSE_EVENTS WHERE ts>=TIMESTAMP_SUB(@as_of,INTERVAL 30 DAY) AND distinct_id IS NOT NULL)
 SELECT p.d AS day,p.dau,m.users AS mau_30d,IF(m.users=0,NULL,ROUND(100.0*p.dau/m.users,1)) AS dau_pct_of_mau FROM per_day p CROSS JOIN mau m ORDER BY p.d`,
 retention:`WITH first_seen AS (SELECT distinct_id,DATE(MIN(ts)) AS cohort_day FROM WAREHOUSE_EVENTS WHERE distinct_id IS NOT NULL GROUP BY distinct_id)
 SELECT f.cohort_day,COUNT(*) AS cohort_size,
 COUNTIF(EXISTS(SELECT 1 FROM WAREHOUSE_EVENTS a WHERE a.distinct_id=f.distinct_id AND DATE(a.ts)=DATE_ADD(f.cohort_day,INTERVAL 1 DAY))) AS d1,
 COUNTIF(EXISTS(SELECT 1 FROM WAREHOUSE_EVENTS a WHERE a.distinct_id=f.distinct_id AND DATE(a.ts)=DATE_ADD(f.cohort_day,INTERVAL 7 DAY))) AS d7,
 COUNTIF(EXISTS(SELECT 1 FROM WAREHOUSE_EVENTS a WHERE a.distinct_id=f.distinct_id AND DATE(a.ts)=DATE_ADD(f.cohort_day,INTERVAL 30 DAY))) AS d30
 FROM first_seen f WHERE f.cohort_day>=DATE_SUB(DATE(@as_of),INTERVAL 60 DAY) GROUP BY f.cohort_day ORDER BY f.cohort_day`,
 funnel:`SELECT COUNT(DISTINCT IF(event='booking_created',distinct_id,NULL)) AS booked,
 COUNT(DISTINCT IF(event='checkin_requested',distinct_id,NULL)) AS checkin_requested,
 COUNT(DISTINCT IF(event='independent_checkin',distinct_id,NULL)) AS self_checkin,
 COUNT(DISTINCT IF(event='trainer_checked_in',distinct_id,NULL)) AS trainer_checkin,
 COUNT(DISTINCT IF(event='booking_completed',distinct_id,NULL)) AS completed,
 COUNT(DISTINCT IF(event='health_consent_granted',distinct_id,NULL)) AS health_opted_in,
 COUNT(DISTINCT distinct_id) AS any_activity FROM WAREHOUSE_EVENTS WHERE ts>=TIMESTAMP_SUB(@as_of,INTERVAL 90 DAY)`,
 gyms:`SELECT p_gym_id AS gym_id,COUNT(*) AS rows_90d,COUNT(DISTINCT distinct_id) AS members_90d,
 MAX(ts) AS last_activity,DATE_DIFF(DATE(@as_of),DATE(MAX(ts)),DAY) AS days_since_activity,
 COUNTIF(DATE(ts)=DATE(@as_of)) AS today,COUNTIF(ts>=TIMESTAMP_SUB(@as_of,INTERVAL 7 DAY)) AS last_7d
 FROM WAREHOUSE_EVENTS WHERE JSON_QUERY(properties,'$.gym_id') IS NOT NULL AND ts>=TIMESTAMP_SUB(@as_of,INTERVAL 90 DAY)
 GROUP BY 1 ORDER BY MAX(ts) DESC NULLS LAST LIMIT 100`
};
