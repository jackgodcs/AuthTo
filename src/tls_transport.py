#!/usr/bin/env python3
"""Small NDJSON bridge around curl_cffi for browser-like TLS requests."""

import base64
import json
import sys

try:
    from curl_cffi import requests
    IMPORT_ERROR = None
except Exception as error:  # pragma: no cover - exercised on missing local dependency
    requests = None
    IMPORT_ERROR = f"{type(error).__name__}: {error}"


def write_message(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Worker:
    def __init__(self):
        self.session = None
        self.proxy = None
        self.impersonate = "chrome146"

    def configure(self, proxy, impersonate):
        if IMPORT_ERROR:
            raise RuntimeError(
                "Python curl_cffi is unavailable. Run: python -m pip install -r requirements.txt "
                f"({IMPORT_ERROR})"
            )
        if self.session is not None:
            self.session.close()
        self.proxy = proxy or None
        self.impersonate = impersonate or "chrome146"
        self.session = requests.Session(impersonate=self.impersonate, proxy=self.proxy)

    def request(self, message):
        if self.session is None:
            self.configure(message.get("proxy"), message.get("impersonate"))

        method = str(message.get("method") or "GET").upper()
        url = str(message.get("url") or "")
        headers = {}
        for pair in message.get("headers") or []:
            if isinstance(pair, list) and len(pair) == 2:
                headers[str(pair[0])] = str(pair[1])

        body = message.get("body")
        body_bytes = base64.b64decode(body) if body else None
        timeout_ms = max(1, int(message.get("timeoutMs") or 30000))
        response = self.session.request(
            method,
            url,
            headers=headers,
            data=body_bytes,
            timeout=timeout_ms / 1000,
            allow_redirects=False,
        )
        header_items = list(response.headers.multi_items()) if hasattr(response.headers, "multi_items") else list(response.headers.items())
        cookies = []
        cookie_jar = getattr(self.session.cookies, "jar", None)
        if cookie_jar is not None:
            for cookie in cookie_jar:
                cookies.append({
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain.lstrip("."),
                    "path": cookie.path or "/",
                    "secure": bool(cookie.secure),
                    # JavaScript Date.now() and the Node cookie jar use milliseconds.
                    "expires": cookie.expires * 1000 if cookie.expires else None,
                })
        return {
            "status": int(response.status_code),
            "headers": [[str(name), str(value)] for name, value in header_items],
            "body": "" if message.get("discardBody") else base64.b64encode(response.content).decode("ascii"),
            "cookies": cookies,
        }


def main():
    worker = Worker()
    for raw_line in sys.stdin:
        try:
            message = json.loads(raw_line)
            request_id = message.get("id")
            operation = message.get("operation", "request")
            if operation == "configure":
                worker.configure(message.get("proxy"), message.get("impersonate"))
                result = {"configured": True}
            elif operation == "close":
                write_message({"id": request_id, "ok": True, "result": {"closed": True}})
                return
            else:
                result = worker.request(message)
            write_message({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            write_message({
                "id": locals().get("request_id"),
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            })


if __name__ == "__main__":
    main()
