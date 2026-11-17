"""One local health-check pass, launched every five minutes by Task Scheduler.

Configuration and rotating logs live beside the installed copy. Authentication
uses the existing local gcloud login; request tokens are never logged or saved
by this script.
"""
import concurrent.futures
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def main():
    home = Path(__file__).resolve().parent
    logger = logging.getLogger("health-warmup")
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(home / "health-warmup.log", maxBytes=1_000_000,
                                  backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    try:
        config = json.loads((home / "health-warmup.json").read_text(encoding="utf-8-sig"))
        targets = config["targets"]
        for name, url in targets.items():
            parsed = urlsplit(url)
            if (not name.endswith("-prod") or parsed.scheme != "https"
                    or not (parsed.hostname or "").endswith(".a.run.app")
                    or parsed.path != "/health" or parsed.query or parsed.fragment
                    or parsed.username or parsed.password or parsed.port):
                raise ValueError("Invalid health target")
        result = subprocess.run(
            [config["gcloud"], "auth", "print-identity-token", "--account=" + config["account"], "--quiet"],
            capture_output=True, text=True, timeout=45, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        token = result.stdout.strip()
        if not token:
            raise ValueError("No identity token")
    except Exception as error:
        # gcloud stderr and HTTP bodies may contain credentials or user data.
        logger.error("Setup/authentication failed (%s); check the configured gcloud login", type(error).__name__)
        return 1

    def check(target):
        name, url = target
        try:
            req = Request(url, headers={"Authorization": "Bearer " + token,
                                       "User-Agent": "PhoolGobhi-Local-Warmup"})
            with urlopen(req, timeout=25) as response:
                status = response.status
            logger.info("service=%s status=%s", name, status)
            return 200 <= status < 300
        except HTTPError as error:
            logger.error("service=%s status=%s", name, error.code)
        except (URLError, TimeoutError, OSError):
            logger.error("service=%s network_or_timeout_error", name)
        except Exception as error:
            logger.error("service=%s error_type=%s", name, type(error).__name__)
        return False

    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
        outcomes = list(pool.map(check, targets.items()))
    logger.info("pass_complete healthy=%s total=%s", sum(outcomes), len(outcomes))
    return 0 if outcomes and all(outcomes) else 1


if __name__ == "__main__":
    sys.exit(main())
