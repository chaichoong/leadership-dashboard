#!/usr/bin/env python3
"""Direct YouTube uploads for the Content Engine (Kevin, 9 Sep 2026: "we definitely need to upload to YouTube direct
because the quality was significantly lower").

Why not GoHighLevel for YouTube: its edge refuses files over about 450 MB (the 740 MB episode 2054 went up as a
335 MB transcode), it cannot set the video's language (the channel default is Arabic, so auto-captions came out in
Arabic), it cannot attach a caption file, and it never marked the post published. The YouTube Data API does all four
and hands the link back at once.

Identity: an OAuth client of the Google Cloud project runpreneur-content-engine (Internal app "Runpreneur Content
Engine"), consented ONCE by Kevin as the channel owner. Files, all 0600, never in the repo:
  ~/.config/od/youtube_oauth_client.json   the client (downloaded from the console)
  ~/.config/od/youtube_token.json          refresh token from Kevin's consent

  youtube_api.py auth           # prints the consent URL, waits on localhost:8765 for Google to send the code, saves the token
  youtube_api.py whoami         # live: the channel the token can upload to
  youtube_api.py selftest
"""
import base64, hashlib, http.server, json, os, secrets, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

CLIENT_FILE = os.path.expanduser("~/.config/od/youtube_oauth_client.json")
TOKEN_FILE = os.path.expanduser("~/.config/od/youtube_token.json")
SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"]
REDIRECT_PORT = 8765
API = "https://www.googleapis.com/youtube/v3"
UPLOAD = "https://www.googleapis.com/upload/youtube/v3"
CHUNK = 64 * 1024 * 1024
LANGUAGE = "en-GB"
CATEGORY_SPORTS = "17"
_tok = {"value": None, "exp": 0}


# ---------- pure helpers (selftested) ----------

def video_body(title, description, tags=(), privacy="public", publish_at=None, language=LANGUAGE, category=CATEGORY_SPORTS, made_for_kids=False):
    """videos.insert body: language set explicitly so YouTube never guesses (the channel default is Arabic, 9 Sep 2026)."""
    status = {"privacyStatus": privacy, "selfDeclaredMadeForKids": made_for_kids}
    if publish_at:
        status["privacyStatus"] = "private"; status["publishAt"] = publish_at      # YouTube publishes a private video at publishAt
    return {"snippet": {"title": title[:100], "description": description[:5000], "tags": list(tags)[:30], "categoryId": category,
                        "defaultLanguage": language, "defaultAudioLanguage": language},
            "status": status}


def caption_body(video_id, language=LANGUAGE, name="English"):
    return {"snippet": {"videoId": video_id, "language": language, "name": name, "isDraft": False}}


def watch_link(video_id):
    return "https://youtu.be/" + video_id


def pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def consent_url(client_id, challenge, state):
    q = {"client_id": client_id, "redirect_uri": "http://localhost:%d/" % REDIRECT_PORT, "response_type": "code", "scope": " ".join(SCOPES),
         "access_type": "offline", "prompt": "consent", "code_challenge": challenge, "code_challenge_method": "S256", "state": state}
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(q)


# ---------- auth ----------

def _client():
    d = json.load(open(CLIENT_FILE)); return d.get("installed") or d.get("web") or d


def auth():
    """Kevin's one-time consent: open the printed URL signed in as the channel owner, click Allow; Google sends the code here."""
    c = _client(); verifier, challenge = pkce(); state = secrets.token_urlsafe(16)
    url = consent_url(c["client_id"], challenge, state)
    print("Open this in the browser signed in as the YouTube channel owner and click Allow:\n\n" + url + "\n")
    got = {}
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query); got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(b"<h2>Runpreneur Content Engine: YouTube access granted. You can close this tab.</h2>")
        def log_message(self, *a): pass
    srv = http.server.HTTPServer(("127.0.0.1", REDIRECT_PORT), H); srv.timeout = 600
    while "code" not in got and "error" not in got: srv.handle_request()
    if got.get("error"): raise SystemExit("consent refused: %s" % got["error"])
    if got.get("state") != state: raise SystemExit("state mismatch: not our consent")
    body = urllib.parse.urlencode({"code": got["code"], "client_id": c["client_id"], "client_secret": c.get("client_secret", ""), "redirect_uri": "http://localhost:%d/" % REDIRECT_PORT,
                                   "grant_type": "authorization_code", "code_verifier": verifier}).encode()
    tok = json.load(urllib.request.urlopen(urllib.request.Request(c["token_uri"], data=body), timeout=60))
    if not tok.get("refresh_token"): raise SystemExit("Google returned no refresh token; retry with prompt=consent (it is set) or remove the app's access in the Google account and retry")
    fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, json.dumps({"refresh_token": tok["refresh_token"], "granted": time.strftime("%F %T")}).encode()); os.close(fd)
    print("token saved to", TOKEN_FILE)


def token(_now=time.time):
    if _tok["value"] and _now() < _tok["exp"] - 120: return _tok["value"]
    c = _client(); rt = json.load(open(TOKEN_FILE))["refresh_token"]
    body = urllib.parse.urlencode({"refresh_token": rt, "client_id": c["client_id"], "client_secret": c.get("client_secret", ""), "grant_type": "refresh_token"}).encode()
    r = json.load(urllib.request.urlopen(urllib.request.Request(c["token_uri"], data=body), timeout=60))
    _tok.update({"value": r["access_token"], "exp": int(_now()) + int(r.get("expires_in", 3600))}); return _tok["value"]


def request(method, url, body=None, headers=None, raw=None, timeout=300):
    h = {"Authorization": "Bearer " + token()}; h.update(headers or {})
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    if body is not None: h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read(); return json.loads(txt) if txt.strip().startswith(b"{") else {"raw": txt[:200], "headers": dict(r.headers)}
    except urllib.error.HTTPError as ex:
        raise RuntimeError("youtube %s %s -> %d: %s" % (method, url[:80], ex.code, ex.read().decode()[:300]))


# ---------- uploads ----------

def upload(path, title, description, tags=(), privacy="public", publish_at=None, thumbnail=None, srt=None, language=LANGUAGE, made_for_kids=False):
    """Resumable upload of the file as it is (no size limit that matters), language set, then thumbnail and captions.
    Returns the video id. YouTube may take minutes to process; the link is valid at once."""
    size = os.path.getsize(path)
    body = video_body(title, description, tags, privacy, publish_at, language, made_for_kids=made_for_kids)
    h = {"Authorization": "Bearer " + token(), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": str(size)}
    req = urllib.request.Request(UPLOAD + "/videos?uploadType=resumable&part=snippet,status", data=json.dumps(body).encode(), method="POST", headers=h)
    with urllib.request.urlopen(req, timeout=120) as r: session = r.headers["Location"]
    vid = None
    with open(path, "rb") as fh:
        first = 0
        while first < size:
            last = min(first + CHUNK, size) - 1; fh.seek(first); buf = fh.read(last - first + 1)
            req = urllib.request.Request(session, data=buf, method="PUT", headers={"Content-Length": str(len(buf)), "Content-Range": "bytes %d-%d/%d" % (first, last, size), "Content-Type": "video/mp4"})
            try:
                with urllib.request.urlopen(req, timeout=900) as r:
                    if last + 1 == size: vid = json.load(r)["id"]
            except urllib.error.HTTPError as ex:
                if ex.code != 308: raise RuntimeError("youtube upload -> %d: %s" % (ex.code, ex.read().decode()[:200]))
            first = last + 1
    if not vid: raise RuntimeError("upload ended without a video id")
    if thumbnail and os.path.exists(thumbnail):
        request("POST", UPLOAD + "/thumbnails/set?videoId=" + vid, raw=open(thumbnail, "rb").read(), headers={"Content-Type": "image/png"})
    if srt and os.path.exists(srt):
        add_captions(vid, srt, language)
    return vid


def add_captions(video_id, srt_path, language=LANGUAGE):
    """Our own caption track, so YouTube's auto-captions never show for this language (Kevin, 9 Sep 2026)."""
    meta = json.dumps(caption_body(video_id, language)).encode(); data = open(srt_path, "rb").read()
    boundary = "ce" + secrets.token_hex(8)
    body = (("--%s\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" % boundary).encode() + meta +
            ("\r\n--%s\r\nContent-Type: application/octet-stream\r\n\r\n" % boundary).encode() + data + ("\r\n--%s--\r\n" % boundary).encode())
    return request("POST", UPLOAD + "/captions?uploadType=multipart&part=snippet", raw=body, headers={"Content-Type": "multipart/related; boundary=" + boundary})


def set_language(video_id, language=LANGUAGE):
    """Fix a video that was uploaded without a language (the GoHighLevel uploads of 2054)."""
    v = request("GET", API + "/videos?part=snippet&id=" + video_id)["items"][0]
    sn = v["snippet"]; sn["defaultLanguage"] = language; sn["defaultAudioLanguage"] = language
    keep = {k: sn[k] for k in ("title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage") if k in sn}
    return request("PUT", API + "/videos?part=snippet", {"id": video_id, "snippet": keep})


def whoami():
    r = request("GET", API + "/channels?part=snippet&mine=true")
    for c in r.get("items", []): print(c["id"], c["snippet"]["title"])


def selftest():
    b = video_body("T" * 120, "d", ["a", "b"], "public", None)
    assert len(b["snippet"]["title"]) == 100 and b["snippet"]["defaultLanguage"] == "en-GB" and b["snippet"]["defaultAudioLanguage"] == "en-GB" and b["status"]["privacyStatus"] == "public"
    b2 = video_body("t", "d", (), "public", "2026-09-10T06:00:00Z"); assert b2["status"]["privacyStatus"] == "private" and b2["status"]["publishAt"] == "2026-09-10T06:00:00Z", "a scheduled video is private until YouTube publishes it"
    assert caption_body("abc")["snippet"] == {"videoId": "abc", "language": "en-GB", "name": "English", "isDraft": False}
    v, c = pkce(); assert len(v) >= 43 and len(c) == 43
    u = consent_url("cid", "chal", "st"); assert "code_challenge=chal" in u and "access_type=offline" in u and "youtube.upload" in urllib.parse.unquote(u) and "localhost%3A8765" in u
    assert watch_link("x") == "https://youtu.be/x" and CHUNK % (256 * 1024) == 0
    print(json.dumps({"checks": 7, "failed": []}))


if __name__ == "__main__":
    if len(sys.argv) < 2: raise SystemExit(__doc__)
    m = sys.argv[1]
    if m == "selftest": selftest()
    elif m == "auth": auth()
    elif m == "whoami": whoami()
    else: raise SystemExit("unknown mode")
