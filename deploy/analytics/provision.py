"""Idempotent analytics warehouse provisioning. No source DB credentials are used.

python deploy/analytics/provision.py --apply
"""
import argparse
import json
import shutil
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

PROJECT = "phool-gobhi"
NUMBER = "1077801427223"
LOCATION = "asia-south1"
PROPERTY_KEYS = "amount anon_distinct_id app channel city geo_city geo_country granted gym_id landing_path method nearest_gym_distance_km permission reason referrer_host screen_name session_id step surface training_location utm_campaign utm_source".split()


class Cloud:
    def __init__(self):
        self.token = subprocess.check_output([shutil.which("gcloud.cmd") or "gcloud", "auth", "print-access-token"], text=True).strip()

    def request(self, url, method="GET", data=None, allow_missing=False):
        request = Request(url, method=method, headers={"Authorization": "Bearer " + self.token,
            "Content-Type": "application/json", "x-goog-user-project": PROJECT}, data=None if data is None else json.dumps(data).encode())
        try:
            with urlopen(request, timeout=60) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except HTTPError as error:
            if allow_missing and error.code == 404:
                return None
            detail = json.loads(error.read()).get("error", {}).get("message", "API request failed")
            raise RuntimeError(f"{method} {url}: {error.code}: {detail}") from None

    def query(self, sql, **options):
        result = self.request(f"https://bigquery.googleapis.com/bigquery/v2/projects/{PROJECT}/queries", "POST", {
            "query": sql, "useLegacySql": False, "location": LOCATION,
            "timeoutMs": 20000, "maximumBytesBilled": str(256 * 1024 * 1024), **options,
        })
        if not result.get("jobComplete"):
            raise RuntimeError("DDL job is still running; inspect job before retrying")
        return result


def schema():
    return [{"name": name, "type": type_, "mode": mode} for name, type_, mode in [
        ("event_id", "STRING", "REQUIRED"), ("event", "STRING", "REQUIRED"),
        ("distinct_id", "STRING", "NULLABLE"), ("properties", "STRING", "REQUIRED"),
        ("source", "STRING", "REQUIRED"), ("service", "STRING", "REQUIRED"),
        ("environment", "STRING", "REQUIRED"), ("ts", "TIMESTAMP", "REQUIRED"),
        ("ingested_at", "TIMESTAMP", "REQUIRED"), ("legacy_id", "INTEGER", "NULLABLE"),
        *[("p_" + key, "STRING", "NULLABLE") for key in PROPERTY_KEYS],
    ]]


def provision(api):
    pubsub = f"https://pubsub.googleapis.com/v1/projects/{PROJECT}"
    bigquery = f"https://bigquery.googleapis.com/bigquery/v2/projects/{PROJECT}"
    agent = f"serviceAccount:service-{NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
    for environment in ("dev", "prod"):
        dataset = "analytics_" + environment
        topic = "analytics-events-" + environment
        dead = topic + "-dead-letter"
        if api.request(f"{bigquery}/datasets/{dataset}", allow_missing=True) is None:
            api.request(f"{bigquery}/datasets", "POST", {"datasetReference": {"projectId": PROJECT, "datasetId": dataset},
                "location": LOCATION, "labels": {"managed_by": "backend-analytics", "environment": environment},
                "description": "Private first-party analytics; partition-filtered and application-deduplicated."})
        raw = f"{bigquery}/datasets/{dataset}/tables/events_raw"
        existing = api.request(raw, allow_missing=True)
        if existing is None:
            api.request(f"{bigquery}/datasets/{dataset}/tables", "POST", {
                "tableReference": {"projectId": PROJECT, "datasetId": dataset, "tableId": "events_raw"},
                "schema": {"fields": schema()}, "timePartitioning": {"type": "DAY", "field": "ts"},
                "clustering": {"fields": ["event", "distinct_id", "service", "p_gym_id"]},
                "requirePartitionFilter": True,
                "labels": {"managed_by": "backend-analytics", "environment": environment},
            })
        else:
            if existing.get("schema", {}).get("fields") != schema():
                raise RuntimeError("Existing raw schema differs; review an explicit schema migration")
            # Preserve first-ever cohorts/identity linkage. Do not age out raw
            # history until persistent first-seen/identity facts replace it.
            if existing.get('timePartitioning',{}).get('expirationMs'):
                api.query(f'ALTER TABLE `{PROJECT}.{dataset}.events_raw` SET OPTIONS (partition_expiration_days=NULL)')
        api.query(f"""CREATE TABLE IF NOT EXISTS `{PROJECT}.{dataset}.erased_actors`
            (distinct_id STRING NOT NULL, erased_at TIMESTAMP NOT NULL)
            CLUSTER BY distinct_id""")
        api.query(f"""CREATE TABLE IF NOT EXISTS `{PROJECT}.{dataset}.deleted_event_ids`
            (event_id STRING NOT NULL, deleted_at TIMESTAMP NOT NULL)
            CLUSTER BY event_id""")
        api.query(f"""CREATE OR REPLACE TABLE FUNCTION `{PROJECT}.{dataset}.events_between`(start_at TIMESTAMP, end_at TIMESTAMP, event_names ARRAY<STRING>)
            AS (SELECT * FROM `{PROJECT}.{dataset}.events_raw` e
              WHERE ts >= start_at AND ts <= end_at
                AND (COALESCE(ARRAY_LENGTH(event_names),0)=0 OR event IN UNNEST(event_names))
                AND event != 'analytics_pipeline_probe'
                AND NOT EXISTS (SELECT 1 FROM `{PROJECT}.{dataset}.erased_actors` a WHERE a.distinct_id=e.distinct_id)
                AND NOT EXISTS (SELECT 1 FROM `{PROJECT}.{dataset}.deleted_event_ids` d WHERE d.event_id=e.event_id)
              QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingested_at DESC)=1)""")
        ds = api.request(f"{bigquery}/datasets/{dataset}")
        access = ds.get("access", [])
        email = agent.split(":", 1)[1]
        if not any(a.get("userByEmail") == email and a.get("role") == "WRITER" for a in access):
            access.append({"role": "WRITER", "userByEmail": email})
            api.request(f"{bigquery}/datasets/{dataset}", "PATCH", {"access": access})
        for name in (topic, dead):
            if api.request(f"{pubsub}/topics/{name}", allow_missing=True) is None:
                api.request(f"{pubsub}/topics/{name}", "PUT", {
                    "messageStoragePolicy": {"allowedPersistenceRegions": [LOCATION]},
                    "labels": {"managed_by": "backend-analytics", "environment": environment}})
        for name, payload in [
            (dead + "-retained", {"topic": f"projects/{PROJECT}/topics/{dead}", "messageRetentionDuration": "2678400s"}),
            (topic + "-warehouse", {"topic": f"projects/{PROJECT}/topics/{topic}",
                "bigqueryConfig": {"table": f"{PROJECT}.{dataset}.events_raw", "useTableSchema": True, "writeMetadata": False, "dropUnknownFields": False},
                "messageRetentionDuration": "604800s", "ackDeadlineSeconds": 60,
                "deadLetterPolicy": {"deadLetterTopic": f"projects/{PROJECT}/topics/{dead}", "maxDeliveryAttempts": 10},
                "retryPolicy": {"minimumBackoff": "10s", "maximumBackoff": "600s"}}),
        ]:
            url = f"{pubsub}/subscriptions/{name}"
            if api.request(url, allow_missing=True) is None:
                api.request(url, "PUT", {**payload, "expirationPolicy": {},
                    "labels": {"managed_by": "backend-analytics", "environment": environment}})
        # The delivery agent also needs forwarding rights on this topic/subscription.
        for kind, name, role in [("topics", dead, "roles/pubsub.publisher"),
                                  ("subscriptions", topic + "-warehouse", "roles/pubsub.subscriber")]:
            resource = f"{pubsub}/{kind}/{name}"
            policy = api.request(resource + ":getIamPolicy")
            bindings = policy.setdefault("bindings", [])
            binding = next((b for b in bindings if b["role"] == role), None)
            if binding is None:
                binding = {"role": role, "members": []}; bindings.append(binding)
            if agent not in binding["members"]:
                binding["members"].append(agent)
                api.request(resource + ":setIamPolicy", "POST", {"policy": policy})
        print(json.dumps({"environment": environment, "dataset": dataset, "topic": topic, "retentionDays": None}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.apply:
        print(json.dumps({"project": PROJECT, "location": LOCATION, "schema": schema(), "action": "preview; add --apply"}))
    else:
        provision(Cloud())
