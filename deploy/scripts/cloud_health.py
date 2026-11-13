"""Reconcile backend monitoring and declared Cloud Run configuration.

Uses the active gcloud identity. Secret values are never read or printed.
Preview: python deploy/scripts/cloud_health.py config
Apply:   python deploy/scripts/cloud_health.py config --apply
Monitor: python deploy/scripts/cloud_health.py monitoring [--email ADDRESS]
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "deploy/services.json").read_text())
PROJECT = MANIFEST["project"]
GCLOUD = shutil.which("gcloud.cmd") or shutil.which("gcloud")


def cloud(*args):
    return subprocess.check_output([GCLOUD, *args], text=True, stderr=subprocess.PIPE)


class Monitoring:
    def __init__(self):
        self.token = cloud("auth", "print-access-token").strip()

    def request(self, collection, method="GET", data=None, query=None):
        version = "v1" if collection.startswith("dashboards") else "v3"
        url = f"https://monitoring.googleapis.com/{version}/projects/{PROJECT}/{collection}"
        if query:
            url += "?" + urlencode(query)
        req = Request(url, method=method, headers={
            "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
        }, data=None if data is None else json.dumps(data).encode())
        try:
            with urlopen(req, timeout=45) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                detail = json.loads(error.read()).get("error", {}).get("message", "request failed")
            except (ValueError, UnicodeError):
                detail = "non-JSON API error"
            raise RuntimeError(f"Monitoring {method} {collection}: {error.code}: {detail}") from None

    def upsert(self, collection, payload):
        existing = self.request(collection).get(collection, [])
        match = next((item for item in existing if item["displayName"] == payload["displayName"]), None)
        if match:
            payload = {**payload, "name": match["name"]}
            if "etag" in match:
                payload["etag"] = match["etag"]
            # Existing condition IDs must not be copied across different conditions.
            suffix = "/".join(match["name"].split("/")[-2:])
            result = self.request(suffix, "PATCH", payload)
        else:
            result = self.request(collection, "POST", payload)
        print(json.dumps({"resource": result["name"], "displayName": result["displayName"]}))
        return result


def threshold(name, metric, value, aligner, duration="600s", production=False):
    filter_ = f'resource.type="cloud_run_revision" AND metric.type="run.googleapis.com/{metric}"'
    if production:
        filter_ += ' AND resource.labels.service_name=monitoring.regex.full_match(".*-prod")'
    if metric == "request_count":
        filter_ += ' AND metric.labels.response_code_class="5xx"'
    return {"displayName": name, "conditionThreshold": {
        "filter": filter_, "comparison": "COMPARISON_GT", "thresholdValue": value,
        "duration": duration, "trigger": {"count": 1},
        "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": aligner,
                          "crossSeriesReducer": "REDUCE_SUM" if metric == "request_count" else "REDUCE_MAX",
                          "groupByFields": ["resource.labels.service_name"]}],
    }}


def configure_monitoring(email):
    api = Monitoring()
    channels = api.request("notificationChannels").get("notificationChannels", [])
    if email:
        channel = next((c for c in channels if c.get("type") == "email" and
                        c.get("labels", {}).get("email_address") == email), None)
        if not channel:
            channel = api.request("notificationChannels", "POST", {
                "type": "email", "displayName": "Backend operations email",
                "labels": {"email_address": email}, "enabled": True,
            })
        channel_names = [channel["name"]]
    else:
        channel_names = [c["name"] for c in channels if c.get("enabled", True)]

    policies = []
    for env in ("dev", "prod"):
        service = json.loads(cloud("run", "services", "describe", f"gateway-{env}",
                                   f"--project={PROJECT}", f"--region={MANIFEST['region']}", "--format=json"))
        host = urlparse(service["status"]["url"]).netloc
        uptime = api.upsert("uptimeCheckConfigs", {
            "displayName": f"Backend gateway {env} health", "period": "300s", "timeout": "10s",
            "monitoredResource": {"type": "uptime_url", "labels": {"project_id": PROJECT, "host": host}},
            "httpCheck": {"path": "/health", "port": 443, "useSsl": True, "validateSsl": True,
                          "acceptedResponseStatusCodes": [{"statusClass": "STATUS_CLASS_2XX"}]},
            "selectedRegions": ["USA", "EUROPE", "ASIA_PACIFIC"], "logCheckFailures": True,
        })
        check_id = uptime["name"].rsplit("/", 1)[-1]
        policies.append((f"Backend {env} gateway unavailable", {"displayName": "Two regions failing", "conditionThreshold": {
            "filter": f'resource.type="uptime_url" AND metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND metric.labels.check_id="{check_id}"',
            "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "120s", "trigger": {"count": 1},
            "aggregations": [{"alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_NEXT_OLDER",
                              "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.labels.host"]}],
        }}))
    policies.extend([
        ("Backend repeated server errors", threshold("More than four 5xx responses per five minutes", "request_count", 4, "ALIGN_SUM", "0s")),
        ("Backend production slow requests", threshold("Production p95 exceeds five seconds", "request_latencies", 5000, "ALIGN_PERCENTILE_95", production=True)),
        ("Backend high memory", threshold("Memory p95 exceeds 85 percent", "container/memory/utilizations", .85, "ALIGN_PERCENTILE_95")),
        ("Backend high CPU", threshold("CPU p95 exceeds 85 percent", "container/cpu/utilizations", .85, "ALIGN_PERCENTILE_95")),
    ])
    for name, condition in policies:
        api.upsert("alertPolicies", {
            "displayName": name, "combiner": "OR", "enabled": True, "conditions": [condition],
            "notificationChannels": channel_names, "alertStrategy": {"autoClose": "1800s"},
            "documentation": {"mimeType": "text/markdown", "content":
                "Inspect Cloud Run traffic, recent request logs and database connectivity. "
                "Runbook: deploy/OPERATIONS.md in Jokerohit4/phool-gobhi-backend. "
                "Keep internal services private and inspect the failing revision before rollback."},
            "userLabels": {"managed_by": "backend-operations"},
        })
    tiles = []
    for index, (title, metric, aligner) in enumerate([
        ("Requests per second", "request_count", "ALIGN_RATE"),
        ("Request latency p95 (ms)", "request_latencies", "ALIGN_PERCENTILE_95"),
        ("Memory utilization p95", "container/memory/utilizations", "ALIGN_PERCENTILE_95"),
        ("CPU utilization p95", "container/cpu/utilizations", "ALIGN_PERCENTILE_95"),
    ]):
        tiles.append({"xPos": (index % 2) * 6, "yPos": (index // 2) * 4, "width": 6, "height": 4,
            "widget": {"title": title, "xyChart": {"dataSets": [{"plotType": "LINE", "timeSeriesQuery": {
                "timeSeriesFilter": {"filter": f'resource.type="cloud_run_revision" AND metric.type="run.googleapis.com/{metric}"',
                    "aggregation": {"alignmentPeriod": "300s", "perSeriesAligner": aligner,
                        "crossSeriesReducer": "REDUCE_SUM" if metric == "request_count" else "REDUCE_MAX",
                        "groupByFields": ["resource.labels.service_name"]}}}}]}}})
    api.upsert("dashboards", {"displayName": "Backend operations", "mosaicLayout": {"columns": 12, "tiles": tiles}})
    print(json.dumps({"notificationChannelsAttached": len(channel_names), "policies": len(policies)}))


def config(apply):
    services = json.loads(cloud("run", "services", "list", f"--project={PROJECT}", "--format=json"))
    for live in services:
        name = live["metadata"]["name"]
        key, env = name.rsplit("-", 1)
        if key not in MANIFEST["services"] or env not in ("dev", "prod"):
            continue
        desired = MANIFEST["services"][key]["env"][env].get("plain", {})
        entries = live["spec"]["template"]["spec"]["containers"][0].get("env", [])
        plain = {e["name"]: e["value"] for e in entries if "value" in e}
        changes = {k: v for k, v in desired.items() if plain.get(k) != v}
        if not changes:
            continue
        print(json.dumps({"service": name, "changedKeys": sorted(changes), "apply": apply}))
        if apply:
            # Update only declared differences; retain secret references, IAM, resources and image.
            if any("," in value for value in changes.values()):
                raise ValueError("Use an env file for values containing commas")
            update = ",".join(f"{k}={v}" for k, v in changes.items())
            cloud("run", "services", "update", name, f"--project={PROJECT}",
                  f"--region={MANIFEST['region']}", f"--update-env-vars={update}", "--quiet")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["monitoring", "config"])
    parser.add_argument("--email")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.action == "monitoring":
        configure_monitoring(args.email)
    else:
        config(args.apply)
