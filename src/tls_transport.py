#!/usr/bin/env python3
"""Small NDJSON bridge around curl_cffi for browser-like TLS requests."""

import base64
from concurrent.futures import ThreadPoolExecutor
import json
import re
import sys
from typing import get_args
from urllib.parse import urljoin, urlparse

try:
    from curl_cffi import requests
    from curl_cffi.requests.impersonate import BrowserTypeLiteral
    IMPORT_ERROR = None
except Exception as error:  # pragma: no cover - exercised on missing local dependency
    requests = None
    BrowserTypeLiteral = None
    IMPORT_ERROR = f"{type(error).__name__}: {error}"


def write_message(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Worker:
    def __init__(self):
        self.session = None
        self.proxy = None
        self.impersonate = "chrome146"
        self.fallback_profiles = ("chrome146", "chrome145", "chrome142", "chrome136")

    def configure(self, proxy, impersonate, allow_fallback=True):
        if IMPORT_ERROR:
            raise RuntimeError(
                "Python curl_cffi is unavailable. Run: python -m pip install -r requirements.txt "
                f"({IMPORT_ERROR})"
            )
        if self.session is not None:
            self.session.close()
            self.session = None
        self.proxy = proxy or None
        requested_profile = impersonate or "chrome146"
        profiles = [requested_profile]
        if allow_fallback:
            profiles.extend(
                profile for profile in self.fallback_profiles if profile != requested_profile
            )

        last_error = None
        for profile in profiles:
            try:
                self.session = requests.Session(impersonate=profile, proxy=self.proxy)
                self.impersonate = profile
                if profile != requested_profile:
                    sys.stderr.write(
                        f"[tls] 指纹 {requested_profile} 不受当前 curl_cffi 支持，已降级为 {profile}\n"
                    )
                return
            except Exception as error:
                last_error = error
                self.session = None
                if not self._is_unsupported_impersonate(error):
                    raise
        raise last_error

    def probe_profiles(self, url, profiles=None, timeout_ms=15000, concurrency=4):
        if IMPORT_ERROR:
            raise RuntimeError(
                "Python curl_cffi is unavailable. Run: python -m pip install -r requirements.txt "
                f"({IMPORT_ERROR})"
            )
        candidates = profiles or self._supported_chrome_profiles()
        if not candidates:
            raise RuntimeError("No desktop Chrome fingerprints are available in the installed curl_cffi")

        if self.session is not None:
            self.session.close()
        self.session = None
        failures = []
        attempts = 0
        batch_size = max(1, min(4, int(concurrency or 4)))
        for offset in range(0, len(candidates), batch_size):
            batch = candidates[offset:offset + batch_size]
            with ThreadPoolExecutor(max_workers=len(batch)) as executor:
                results = list(executor.map(
                    lambda profile: self._probe_profile(profile, url, timeout_ms),
                    batch,
                ))
            attempts += len(batch)

            selected_index = next(
                (index for index, result in enumerate(results) if result[1] is not None),
                None,
            )
            if selected_index is not None:
                selected_profile = batch[selected_index]
                selected_session = results[selected_index][0]
                for index, (session, _, _) in enumerate(results):
                    if index != selected_index and session is not None:
                        session.close()
                self.session = selected_session
                self.proxy = None
                self.impersonate = selected_profile
                return {"profile": selected_profile, "attempts": attempts}

            for profile, (session, _, failure) in zip(batch, results):
                if session is not None:
                    session.close()
                failures.append(f"{profile}={failure}")

        summary = ", ".join(failures[-8:])
        raise RuntimeError(
            "No supported desktop Chrome fingerprint reached ChatGPT without a security-check page"
            + (f": {summary}" if summary else "")
        )

    @classmethod
    def _probe_profile(cls, profile, url, timeout_ms):
        session = None
        try:
            session = requests.Session(impersonate=profile, proxy=None)
            response = session.get(
                url,
                timeout=max(1, int(timeout_ms)) / 1000,
                allow_redirects=False,
            )
            if cls._is_usable_probe_response(response, url):
                return session, response, None
            return session, None, f"HTTP {int(response.status_code)}"
        except Exception as error:
            return session, None, type(error).__name__

    @staticmethod
    def _supported_chrome_profiles():
        values = get_args(BrowserTypeLiteral) if BrowserTypeLiteral is not None else ()
        profiles = {
            value for value in values
            if isinstance(value, str) and re.fullmatch(r"chrome\d+[a-z]?", value)
        }

        def sort_key(profile):
            match = re.fullmatch(r"chrome(\d+)([a-z]?)", profile)
            return (int(match.group(1)), match.group(2))

        return sorted(profiles, key=sort_key, reverse=True)

    @staticmethod
    def _is_usable_probe_response(response, request_url="https://chatgpt.com/"):
        status = int(response.status_code)
        headers = {str(name).lower(): str(value) for name, value in response.headers.items()}
        if not 200 <= status < 400:
            return False
        if "challenge" in (headers.get("cf-mitigated") or headers.get("x-cf-mitigated") or "").lower():
            return False
        if 300 <= status < 400:
            location = headers.get("location") or ""
            if not location:
                return False
            target = urlparse(urljoin(request_url, location))
            source = urlparse(request_url)
            if target.hostname != source.hostname:
                return False
            if re.search(r"cdn-cgi|challenge|captcha|security-check|verify", target.path + "?" + target.query, re.I):
                return False
        body = bytes(response.content or b"")[:200000].decode("utf-8", errors="ignore")
        return re.search(r"Just a moment|cdn-cgi|challenge-platform|cf-challenge", body, re.I) is None

    @staticmethod
    def _is_unsupported_impersonate(error):
        message = str(error or "")
        return "impersonat" in message.lower() and "not supported" in message.lower()

    def _request_with_profile_fallback(self, method, url, headers, body_bytes, timeout_ms):
        try:
            return self.session.request(
                method,
                url,
                headers=headers,
                data=body_bytes,
                timeout=timeout_ms / 1000,
                allow_redirects=False,
            )
        except Exception as error:
            if not self._is_unsupported_impersonate(error):
                raise

            original_profile = self.impersonate
            last_error = error
            for profile in self.fallback_profiles:
                if profile == original_profile:
                    continue
                try:
                    self.configure(self.proxy, profile, allow_fallback=False)
                    response = self.session.request(
                        method,
                        url,
                        headers=headers,
                        data=body_bytes,
                        timeout=timeout_ms / 1000,
                        allow_redirects=False,
                    )
                    sys.stderr.write(
                        f"[tls] 指纹 {original_profile} 不受当前 curl_cffi 支持，已降级为 {profile}\n"
                    )
                    return response
                except Exception as fallback_error:
                    last_error = fallback_error
                    if not self._is_unsupported_impersonate(fallback_error):
                        raise
            raise last_error

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
        response = self._request_with_profile_fallback(
            method, url, headers, body_bytes, timeout_ms
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
                result = {"configured": True, "profile": worker.impersonate}
            elif operation == "probe_profiles":
                result = worker.probe_profiles(
                    str(message.get("url") or "https://chatgpt.com/"),
                    message.get("profiles"),
                    message.get("probeTimeoutMs") or 15000,
                    message.get("concurrency") or 4,
                )
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
