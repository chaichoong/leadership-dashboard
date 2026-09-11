#!/usr/bin/env python3
"""Google Drive API lane for the Content Engine (Kevin, 9 Sep 2026: "switch to the Drive API download").

Why: Drive for desktop keeps every raw clip it fetches and every finished video cached on the Mac (22 GB by
9 Sep 2026) with no command to clear it, and a pull through the mount can stall for 40 minutes on EDEADLK while
Drive is busy uploading. Through the API a raw clip streams straight into the work folder (deleted after the
render) and a finished video goes straight up to the shared drive, so the Mac's cache stops growing.

Identity: service account content-engine@runpreneur-content-engine.iam.gserviceaccount.com, a Content manager on
the Marketing shared drive (Kevin added it 9 Sep 2026). Key at ~/.config/od/gdrive_service_account.json (0600,
never in the repo). Token: RS256 JWT signed with openssl (no google libraries needed), one hour, cached.

  drive_api.py selftest            # offline: helpers
  drive_api.py smoke               # live: list the shared drive, the raw and edited roots, one small download+upload
  drive_api.py find <path>         # live: id of a folder path under the shared drive, e.g. "Runpreneur/Runpreneur Edited Video"
"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

KEY_FILE = os.path.expanduser("~/.config/od/gdrive_service_account.json")
IDS_FILE = os.path.expanduser("~/knowledge-os/logs/content-engine/drive_ids.json")   # folder ids, cached outside the public repo
SHARED_DRIVE = "Marketing"
RAW_PATH = ["Runpreneur", "Runpreneur - Raw Video"]
EDITED_PATH = ["Runpreneur", "Runpreneur Edited Video"]
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
CHUNK = 32 * 1024 * 1024          # download and upload chunk (a multiple of 256 KiB, as resumable upload demands)
RETRIES, RETRY_SECONDS = 6, 20
FOLDER = "application/vnd.google-apps.folder"

_tok = {"value": None, "exp": 0}


# ---------- pure helpers (selftested) ----------

def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=")


def jwt_claims(email, token_uri, now, scope="https://www.googleapis.com/auth/drive"):
    return {"iss": email, "scope": scope, "aud": token_uri, "iat": now, "exp": now + 3600}


def ranges(total, start=0, chunk=CHUNK):
    """(first, last) byte ranges from `start` to the end, chunked. A resumed download starts where the .part ended."""
    out = []; a = start
    while a < total:
        b = min(a + chunk, total) - 1; out.append((a, b)); a = b + 1
    return out


def content_range(first, last, total):
    return "bytes %d-%d/%d" % (first, last, total)


def link(file_id):
    return "https://drive.google.com/file/d/%s/view" % file_id


def q_escape(name):
    return name.replace("\\", "\\\\").replace("'", "\\'")


# ---------- auth ----------

def token(_now=time.time):
    if _tok["value"] and _now() < _tok["exp"] - 120: return _tok["value"]
    sa = json.load(open(KEY_FILE))
    now = int(_now())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = b64url(json.dumps(jwt_claims(sa["client_email"], sa["token_uri"], now), separators=(",", ":")).encode())
    signing = header + b"." + claims
    with tempfile.NamedTemporaryFile("w", delete=False) as kf: kf.write(sa["private_key"]); kp = kf.name
    try: sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", kp], input=signing, capture_output=True, check=True).stdout
    finally: os.remove(kp)
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": (signing + b"." + b64url(sig)).decode()}).encode()
    r = json.load(urllib.request.urlopen(urllib.request.Request(sa["token_uri"], data=body), timeout=60))
    _tok.update({"value": r["access_token"], "exp": now + int(r.get("expires_in", 3600))})
    return _tok["value"]


def request(method, url, body=None, headers=None, raw=False, timeout=120, _sleep=time.sleep):
    """One API call with retries on network trouble and 5xx/429; 4xx raise at once (a real answer)."""
    for attempt in range(RETRIES):
        h = {"Authorization": "Bearer " + token()}; h.update(headers or {})
        data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        if data is not None and not isinstance(body, bytes): h["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            if raw: return resp                                    # the caller reads and closes it (a closed response reads as empty)
            with resp as r:
                return json.load(r) if r.headers.get("Content-Type", "").startswith("application/json") else r.read()
        except urllib.error.HTTPError as ex:
            if ex.code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
                _sleep(RETRY_SECONDS * (attempt + 1)); continue
            raise RuntimeError("drive %s %s -> %d: %s" % (method, url[:90], ex.code, ex.read().decode()[:300]))
        except (urllib.error.URLError, OSError) as ex:
            if attempt == RETRIES - 1: raise
            print("drive: %s (%s); retry %d/%d" % (method, str(ex)[:60], attempt + 1, RETRIES - 1), file=sys.stderr); _sleep(RETRY_SECONDS)


# ---------- folders ----------

def _ids():
    try: return json.load(open(IDS_FILE))
    except (OSError, ValueError): return {}


def _save_ids(d):
    os.makedirs(os.path.dirname(IDS_FILE), exist_ok=True)
    tmp = IDS_FILE + ".tmp"; json.dump(d, open(tmp, "w"), indent=1); os.replace(tmp, IDS_FILE)


def drive_id():
    ids = _ids()
    if ids.get("drive"): return ids["drive"]
    r = request("GET", API + "/drives?pageSize=50")
    for d in r.get("drives", []):
        if d["name"] == SHARED_DRIVE:
            ids["drive"] = d["id"]; _save_ids(ids); return d["id"]
    raise RuntimeError("shared drive %r is not visible to the service account (is it a member?)" % SHARED_DRIVE)


def _children(parent, name=None, folders_only=False, page_size=200):
    q = "'%s' in parents and trashed = false" % parent
    if name: q += " and name = '%s'" % q_escape(name)
    if folders_only: q += " and mimeType = '%s'" % FOLDER
    out, page = [], None
    while True:
        url = API + "/files?" + urllib.parse.urlencode({"q": q, "corpora": "drive", "driveId": drive_id(), "includeItemsFromAllDrives": "true",
                                                         "supportsAllDrives": "true", "pageSize": page_size, "fields": "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
                                                         **({"pageToken": page} if page else {})})
        r = request("GET", url); out += r.get("files", []); page = r.get("nextPageToken")
        if not page: return out


def folder_id(path, create=False):
    """Id of a folder path under the shared drive root, e.g. ["Runpreneur", "Runpreneur Edited Video", "2001-2100", "2054"]."""
    key = "/".join(path); ids = _ids()
    if ids.get(key): return ids[key]
    parent = drive_id()
    for i, name in enumerate(path):
        sub = "/".join(path[:i + 1])
        if ids.get(sub): parent = ids[sub]; continue
        hits = [f for f in _children(parent, name=name, folders_only=True)]
        if hits: parent = hits[0]["id"]
        elif create:
            r = request("POST", API + "/files?supportsAllDrives=true", {"name": name, "mimeType": FOLDER, "parents": [parent]}); parent = r["id"]
        else: raise RuntimeError("folder not found: %s" % sub)
        ids[sub] = parent
    _save_ids(ids); return parent


def list_folder(fid):
    return _children(fid)


# ---------- files ----------

def download(file_id, dest, size=None, sleep=time.sleep):
    """Stream a file into `dest` in chunks, resuming a partial `dest` if it exists. Returns bytes on disk."""
    if size is None:
        size = int(request("GET", API + "/files/%s?supportsAllDrives=true&fields=size" % file_id)["size"])
    have = os.path.getsize(dest) if os.path.exists(dest) else 0
    if have > size: os.remove(dest); have = 0
    with open(dest, "ab") as out:
        for first, last in ranges(size, have):
            for attempt in range(RETRIES):
                try:
                    r = request("GET", API + "/files/%s?alt=media&supportsAllDrives=true" % file_id, headers={"Range": "bytes=%d-%d" % (first, last)}, raw=True, timeout=300)
                    with r: buf = r.read()
                    if len(buf) != last - first + 1: raise OSError("short read %d of %d" % (len(buf), last - first + 1))
                    out.write(buf); out.flush(); break
                except (OSError, RuntimeError) as ex:
                    if attempt == RETRIES - 1: raise
                    print("drive download: %s; retry %d" % (str(ex)[:80], attempt + 1), file=sys.stderr); sleep(RETRY_SECONDS)
    return os.path.getsize(dest)


def upload(local, parent, name=None, mime="application/octet-stream"):
    """Resumable upload into a folder; replaces a same-named file in that folder so a re-render never leaves two. Returns the file id."""
    name = name or os.path.basename(local); size = os.path.getsize(local)
    for old in _children(parent, name=name):
        request("PATCH", API + "/files/%s?supportsAllDrives=true" % old["id"], {"trashed": True})
    r = request("POST", UPLOAD + "?uploadType=resumable&supportsAllDrives=true", {"name": name, "parents": [parent]},
                headers={"X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(size)}, raw=True)
    session = r.headers["Location"]
    with open(local, "rb") as fh:
        for first, last in ranges(size):
            fh.seek(first); buf = fh.read(last - first + 1)
            for attempt in range(RETRIES):
                req = urllib.request.Request(session, data=buf, method="PUT", headers={"Content-Length": str(len(buf)), "Content-Range": content_range(first, last, size), "Content-Type": mime})
                try:
                    with urllib.request.urlopen(req, timeout=600) as resp:
                        if last + 1 == size: return json.load(resp)["id"]
                    break
                except urllib.error.HTTPError as ex:
                    if ex.code == 308: break                    # chunk accepted, more to come
                    if attempt == RETRIES - 1: raise RuntimeError("drive upload -> %d: %s" % (ex.code, ex.read().decode()[:200]))
                    time.sleep(RETRY_SECONDS)
                except (urllib.error.URLError, OSError) as ex:
                    if attempt == RETRIES - 1: raise
                    time.sleep(RETRY_SECONDS)
    raise RuntimeError("upload ended without a file id")


# ---------- commands ----------

def smoke():
    print("shared drive:", drive_id())
    raw = folder_id(RAW_PATH); ed = folder_id(EDITED_PATH)
    print("raw root:", raw, "| edited root:", ed)
    print("raw children:", [f["name"] for f in list_folder(raw)][:8])
    test = folder_id(EDITED_PATH + ["_content-engine-api-test"], create=True)
    p = os.path.join(tempfile.gettempdir(), "ce-api-smoke.txt"); open(p, "w").write("content engine api smoke %s\n" % time.strftime("%F %T"))
    fid = upload(p, test, mime="text/plain"); print("uploaded:", link(fid))
    q = os.path.join(tempfile.gettempdir(), "ce-api-smoke-back.txt"); n = download(fid, q); print("downloaded back:", n, "bytes, same:", open(p).read() == open(q).read())
    request("PATCH", API + "/files/%s?supportsAllDrives=true" % fid, {"trashed": True})
    request("PATCH", API + "/files/%s?supportsAllDrives=true" % test, {"trashed": True}); ids = _ids(); ids.pop("/".join(EDITED_PATH + ["_content-engine-api-test"]), None); _save_ids(ids)
    print("test file and folder trashed")


def selftest():
    assert ranges(10, 0, 4) == [(0, 3), (4, 7), (8, 9)] and ranges(10, 8, 4) == [(8, 9)] and ranges(0) == [], "chunking resumes from what is on disk"
    assert content_range(0, 3, 10) == "bytes 0-3/10" and link("abc") == "https://drive.google.com/file/d/abc/view"
    assert q_escape("Kevin's 'run'") == "Kevin\\'s \\'run\\'"
    c = jwt_claims("sa@x.iam", "https://oauth2.googleapis.com/token", 1000); assert c["exp"] == 4600 and c["scope"].endswith("/auth/drive")
    assert b64url(b"\xfb\xff") == b"-_8" and CHUNK % (256 * 1024) == 0, "resumable upload chunks must be multiples of 256 KiB"
    assert RAW_PATH[-1] == "Runpreneur - Raw Video" and EDITED_PATH[-1] == "Runpreneur Edited Video"
    print(json.dumps({"checks": 9, "failed": []}))


if __name__ == "__main__":
    if len(sys.argv) < 2: raise SystemExit(__doc__)
    if sys.argv[1] == "selftest": selftest()
    elif sys.argv[1] == "smoke": smoke()
    elif sys.argv[1] == "find": print(folder_id(sys.argv[2].split("/")))
    else: raise SystemExit("unknown mode")
