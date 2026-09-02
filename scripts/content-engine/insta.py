"""Insta360 X4 .insv helpers for the 360 spike.

Geometry convention (matches ffmpeg v360 after calibration below):
  unit direction d = (x, y, z); z forward = centre of the "front" lens (stream FRONT),
  y down, x right. yaw = atan2(x, z), pitch = -asin(y)  (pitch > 0 looks up).
Each lens is modelled as equidistant fisheye, circle centred in its 2880x2880 frame,
full frame width spanning LENS_FOV degrees.
"""
import numpy as np, subprocess, os, sys, json

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
SIZE = 2880
LENS_FOV = 190.0
FRONT = 1   # stream index that looks at Kevin (yaw 0 in the v360 stitch)
BACK = 0

# sign calibration (set by calibrate(); defaults are the values found on 2 Sep 2026)
MIRROR = {"front": (1.0, 1.0), "back": (-1.0, 1.0)}
ROLL180 = {"front": False, "back": False}


_SIZE_CACHE = {}


def lens_size(path):
    """Pixel size of each lens stream (2880 for 5.7K, 3840 for 8K)."""
    if path not in _SIZE_CACHE:
        out = subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=width", "-of", "csv=p=0", path],
                             check=True, capture_output=True, text=True).stdout.strip().split("\n")[0]
        _SIZE_CACHE[path] = int(out)
    return _SIZE_CACHE[path]


def decode_frame(path, t, stream):
    """One frame of one stream as HxWx3 uint8 (RGB)."""
    n = lens_size(path)
    cmd = [FFMPEG, "-v", "error", "-ss", str(t), "-i", path, "-map", "0:%d" % stream,
           "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(n, n, 3)


def frame_stream(path, stream, w=None, h=None, fps=None, start=None, end=None):
    """Yield frames of one stream as HxWx3 uint8."""
    n = lens_size(path)
    w = w or n; h = h or n
    cmd = [FFMPEG, "-v", "error"]
    if start is not None: cmd += ["-ss", str(start)]
    cmd += ["-i", path]
    if end is not None: cmd += ["-t", str((end - (start or 0)))]
    cmd += ["-map", "0:%d" % stream]
    vf = []
    if fps: vf.append("fps=%s" % fps)
    if (w, h) != (n, n): vf.append("scale=%d:%d" % (w, h))
    if vf: cmd += ["-vf", ",".join(vf)]
    cmd += ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=w * h * 3 * 4)
    n = w * h * 3
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n: break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    p.wait()


def dirs_to_lens_uv(d, which, size=SIZE, fov=LENS_FOV):
    """Directions (N,3) -> pixel coords (u,v) in the given lens frame, plus angle from axis."""
    x, y, z = d[:, 0], d[:, 1], d[:, 2]
    if which == "back":
        z = -z
    theta = np.arccos(np.clip(z, -1, 1))                  # angle from lens axis
    lh = np.hypot(x, y); lh[lh == 0] = 1.0
    r = theta / np.deg2rad(fov / 2.0) * (size / 2.0)       # equidistant
    mx, my = MIRROR[which]
    if ROLL180[which]: mx, my = -mx, -my
    u = size / 2.0 + r * (x / lh) * mx
    v = size / 2.0 + r * (y / lh) * my
    return u, v, theta


def bilinear(img, u, v):
    h, w = img.shape[:2]
    u = np.clip(u, 0, w - 1.001); v = np.clip(v, 0, h - 1.001)
    u0 = np.floor(u).astype(np.int32); v0 = np.floor(v).astype(np.int32)
    fu = (u - u0)[:, None]; fv = (v - v0)[:, None]
    a = img[v0, u0].astype(np.float32); b = img[v0, u0 + 1].astype(np.float32)
    c = img[v0 + 1, u0].astype(np.float32); e = img[v0 + 1, u0 + 1].astype(np.float32)
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + e * fu) * fv


def sample(front, back, d, feather_deg=8.0, fov=LENS_FOV):
    """Sample colours for directions d (N,3) from both lens images with a feathered blend."""
    uf, vf, thf = dirs_to_lens_uv(d, "front", size=front.shape[0], fov=fov)
    ub, vb, thb = dirs_to_lens_uv(d, "back", size=back.shape[0], fov=fov)
    half = np.deg2rad(fov / 2.0)
    wf = np.clip((half - thf) / np.deg2rad(feather_deg), 0, 1)
    wb = np.clip((half - thb) / np.deg2rad(feather_deg), 0, 1)
    s = wf + wb; s[s == 0] = 1.0
    wf, wb = (wf / s)[:, None], (wb / s)[:, None]
    out = np.zeros((d.shape[0], 3), np.float32)
    mf = wf[:, 0] > 0; mb = wb[:, 0] > 0
    if mf.any(): out[mf] += wf[mf] * bilinear(front, uf[mf], vf[mf])
    if mb.any(): out[mb] += wb[mb] * bilinear(back, ub[mb], vb[mb])
    return np.clip(out, 0, 255).astype(np.uint8)


def equirect_dirs(w, h):
    lon = (np.arange(w) + 0.5) / w * 2 * np.pi - np.pi          # -pi..pi, 0 at centre
    lat = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi           # +pi/2 top .. -pi/2 bottom
    LON, LAT = np.meshgrid(lon, lat)
    x = np.cos(LAT) * np.sin(LON); y = -np.sin(LAT); z = np.cos(LAT) * np.cos(LON)
    return np.stack([x, y, z], -1).reshape(-1, 3).astype(np.float32)


def render_equirect(front, back, w=960, h=480, **kw):
    d = equirect_dirs(w, h)
    return sample(front, back, d, **kw).reshape(h, w, 3)


def write_png(path, img):
    """Write RGB uint8 via ffmpeg (no PIL on this Mac)."""
    h, w = img.shape[:2]
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (w, h),
                    "-i", "-", path], input=img.tobytes(), check=True)


def read_image(path, w, h):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vf", "scale=%d:%d" % (w, h), "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3)


if __name__ == "__main__":
    # calibration: compare every mirror/roll combination against ffmpeg's v360 dfisheye stitch
    clip, t, ref = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    front = decode_frame(clip, t, FRONT); back = decode_frame(clip, t, BACK)
    refimg = read_image(ref, 480, 240).astype(np.float32)
    best = None
    for fmx in (1, -1):
        for fmy in (1, -1):
            for bmx in (1, -1):
                for bmy in (1, -1):
                    MIRROR["front"] = (fmx, fmy); MIRROR["back"] = (bmx, bmy)
                    img = render_equirect(front, back, 480, 240, feather_deg=0.01).astype(np.float32)
                    mse = float(((img - refimg) ** 2).mean())
                    print("front", (fmx, fmy), "back", (bmx, bmy), "mse %.1f" % mse)
                    if best is None or mse < best[0]: best = (mse, (fmx, fmy), (bmx, bmy), img)
    print("BEST", best[:3])
    MIRROR["front"], MIRROR["back"] = best[1], best[2]
    write_png(os.path.join(os.path.dirname(ref), "my_equirect.png"), render_equirect(front, back, 960, 480).astype(np.uint8))
    json.dump({"front": best[1], "back": best[2]}, open(os.path.join(os.path.dirname(ref), "lens_calib.json"), "w"))
