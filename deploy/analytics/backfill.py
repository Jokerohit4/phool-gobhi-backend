"""Consistent source snapshot -> private BigQuery load -> idempotent merge.

Only redacted receipts are kept. The local event file and staging table are removed.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location("analytics_provision", Path(__file__).with_name("provision.py"))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


def backfill(environment, prepare=False):
    api = provision.Cloud()
    project = provision.PROJECT
    dataset = "analytics_" + environment
    owned = Path(tempfile.mkdtemp(prefix="analytics-backfill-"))
    snapshot = owned / "events.ndjson"
    staging = "migration_" + uuid.uuid4().hex
    table_url = f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/datasets/{dataset}/tables/{staging}"
    created = False
    try:
        args = ["node", "tools/analytics/source-snapshot.cjs", environment, str(snapshot)]
        if prepare:
            args.append("--prepare-dual")
        subprocess.run(args, check=True)
        receipt = json.loads(Path(str(snapshot) + ".receipt.json").read_text())
        body = snapshot.read_bytes()
        metadata = {"jobReference": {"projectId": project, "location": provision.LOCATION}, "configuration": {"load": {
            "destinationTable": {"projectId": project, "datasetId": dataset, "tableId": staging},
            "sourceFormat": "NEWLINE_DELIMITED_JSON", "writeDisposition": "WRITE_EMPTY", "schema": {"fields": provision.schema()},
        }}}
        boundary = "analytics_" + uuid.uuid4().hex
        upload = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode() + json.dumps(metadata).encode() +
            f"\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + body + f"\r\n--{boundary}--\r\n".encode())
        from urllib.request import Request, urlopen
        request = Request(f"https://bigquery.googleapis.com/upload/bigquery/v2/projects/{project}/jobs?uploadType=multipart",
            data=upload, headers={"Authorization": "Bearer " + api.token, "Content-Type": "multipart/related; boundary=" + boundary}, method="POST")
        with urlopen(request, timeout=60) as response:
            job = json.load(response)
        created = True
        reference = job["jobReference"]
        for attempt in range(120):
            job = api.request(f"https://bigquery.googleapis.com/bigquery/v2/projects/{project}/jobs/{reference['jobId']}?location={provision.LOCATION}")
            if job["status"]["state"] == "DONE":
                break
            time.sleep(1)
        if job["status"].get("errorResult"):
            raise RuntimeError("Historical load failed: " + job["status"]["errorResult"]["message"])
        api.query(f"""MERGE `{project}.{dataset}.events_raw` target USING `{project}.{dataset}.{staging}` incoming
            ON target.event_id=incoming.event_id
               AND target.ts >= TIMESTAMP('{receipt['earliestTimestamp']}') AND target.ts <= TIMESTAMP('{receipt['asOf']}')
            WHEN NOT MATCHED THEN INSERT ROW""")
        verification = api.query(f"""SELECT count(*) AS missing FROM `{project}.{dataset}.{staging}` s
            WHERE NOT EXISTS (SELECT 1 FROM `{project}.{dataset}.events_raw` d
              WHERE d.ts >= TIMESTAMP('{receipt['earliestTimestamp']}') AND d.ts <= TIMESTAMP('{receipt['asOf']}')
                AND d.event_id=s.event_id AND d.event=s.event
                AND TO_JSON_STRING(PARSE_JSON(d.properties))=TO_JSON_STRING(PARSE_JSON(s.properties))
                AND d.ts=s.ts AND d.distinct_id IS NOT DISTINCT FROM s.distinct_id
                AND d.source IS NOT DISTINCT FROM s.source AND d.service IS NOT DISTINCT FROM s.service)""")
        if verification.get("rows", [{}])[0].get("f", [{}])[0].get("v") != "0":
            raise RuntimeError("Historical content reconciliation failed")
        # A later source snapshot may include intentional demo cleanup or other
        # source deletions. Never resurrect those rows in reports. Tombstones
        # preserve the private rollback history without deleting warehouse data.
        # Rows published after this snapshot are excluded by the ID/time bounds.
        api.query(f"""MERGE `{project}.{dataset}.deleted_event_ids` target USING (
            SELECT DISTINCT event_id FROM `{project}.{dataset}.events_raw` d
            WHERE ts BETWEEN TIMESTAMP('1970-01-01') AND TIMESTAMP('{receipt['asOf']}')
              AND legacy_id IS NOT NULL AND legacy_id <= {int(receipt['maximumLegacyId'])}
              AND NOT EXISTS (SELECT 1 FROM `{project}.{dataset}.{staging}` s WHERE s.event_id=d.event_id)
            ) missing ON target.event_id=missing.event_id
            WHEN NOT MATCHED THEN INSERT (event_id,deleted_at) VALUES (missing.event_id,TIMESTAMP('{receipt['asOf']}'))""")
        api.query(f"""DELETE FROM `{project}.{dataset}.deleted_event_ids` d
            WHERE EXISTS (SELECT 1 FROM `{project}.{dataset}.{staging}` s WHERE s.event_id=d.event_id)""")
        deleted=api.query(f'SELECT count(*) AS n FROM `{project}.{dataset}.deleted_event_ids`')
        receipt['sourceDeletionTombstones']=int(deleted['rows'][0]['f'][0]['v'])
        receipt.update({"warehouseContentMatched": True, "snapshotUploadedAsArtifact": False})
        output = Path("docs") / f"analytics-backfill-{environment}-receipt.json"
        output.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"receipt": str(output), "rows": receipt["rows"], "matched": True}))
    finally:
        if created:
            api.request(table_url, "DELETE", allow_missing=True)
        for path in owned.iterdir():
            path.unlink()
        owned.rmdir()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("environment", choices=["dev", "prod"])
    parser.add_argument("--prepare-dual", action="store_true")
    args = parser.parse_args()
    backfill(args.environment, args.prepare_dual)
