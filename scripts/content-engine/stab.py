"""Gyro-based horizon lock + smoothed third-person reframe for Insta360 X4 .insv.

Usage:
  python3 stab.py calib CLIP OUT.png            # 24 axis-mapping candidates x 3 times, pick by eye
  python3 stab.py render CLIP OUT.mp4 [--map XYZ] [--dfov 200] [--start S --end E] [--size 1920x1080]
"""
import sys, os, json, math, subprocess, itertools, argparse
import numpy as np
import telemetry_parser as tp
import insta

FPS = 24.0
STICK_CAM = np.array([0.0, 1.0, 0.0], np.float32)   # sphere "down" = along the stick towards Kevin
UP_WORLD = np.array([0.0, -1.0, 0.0], np.float32)   # y is down in the sphere frame


def load_imu(path):
    """IMU via telemetry_parser.normalized_imu(): gyro deg/s, accel in g-ish units (normalised here)."""
    p = tp.Parser(path)
    n = p.normalized_imu()
    t = np.array([s["timestamp_ms"] for s in n], np.float64) / 1000.0
    gyro = np.deg2rad(np.array([s["gyro"] for s in n], np.float64))
    acc = np.array([s["accl"] for s in n], np.float64)
    acc = acc / np.linalg.norm(acc, axis=1, keepdims=True).clip(1e-6)
    return t, gyro, acc


def mapping_matrices():
    """All 24 signed axis permutations as 3x3 matrices, named like 'xyz', 'x-zy' ..."""
    out = {}
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            M = np.zeros((3, 3))
            name = ""
            for i, (p, s) in enumerate(zip(perm, signs)):
                M[i, p] = s
                name += ("-" if s < 0 else "") + "xyz"[p]
            if round(np.linalg.det(M)) == 1:      # proper rotations only
                out[name] = M
    return out


def skew_exp(w):
    """Rotation matrix for rotation vector w (rad)."""
    th = np.linalg.norm(w)
    if th < 1e-12: return np.eye(3)
    k = w / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * (K @ K)


def integrate(t, gyro, acc, M, gain=0.003):
    """Complementary filter. Returns R_world_from_cam at every IMU sample (N,3,3)."""
    gs = gyro @ M.T; acs = acc @ M.T
    # initial orientation: align measured up with UP_WORLD
    up0 = acs[:200].mean(0); up0 /= np.linalg.norm(up0)
    v = np.cross(up0, UP_WORLD); s = np.linalg.norm(v); c = float(np.dot(up0, UP_WORLD))
    R = skew_exp(v / s * math.atan2(s, c)) if s > 1e-9 else np.eye(3)
    Rs = np.empty((len(t), 3, 3))
    for i in range(len(t)):
        if i > 0:
            dt = t[i] - t[i - 1]
            R = R @ skew_exp(gs[i] * dt)               # body rates -> right-multiply
            # gravity correction: rotate R so that R*acc moves towards UP_WORLD
            upw = R @ acs[i]; n = np.linalg.norm(upw)
            if n > 0.5:
                upw /= n
                corr = np.cross(upw, UP_WORLD)
                R = skew_exp(corr * gain) @ R
        Rs[i] = R
    return Rs


def per_frame_R(t, Rs, n_frames, fps=FPS, offset=0.0):
    ft = np.arange(n_frames) / fps + offset
    idx = np.clip(np.searchsorted(t, ft), 0, len(t) - 1)
    return Rs[idx]


def smooth_dirs(dirs, win):
    """Centred moving average of unit vectors (N,3), renormalised."""
    if win <= 1: return dirs
    k = np.ones(win) / win
    pad = win // 2
    padded = np.pad(dirs, ((pad, pad), (0, 0)), mode="edge")
    sm = np.stack([np.convolve(padded[:, i], k, mode="valid") for i in range(3)], 1)
    sm = sm[:dirs.shape[0]]
    return sm / np.linalg.norm(sm, axis=1, keepdims=True)


def view_dirs(w, h, dfov_deg, proj="sg", hfov_deg=120.0):
    """Pixel directions in the view frame (x right, y down, z forward).
    proj: sg = stereographic (dfov diagonal), flat = rectilinear (hfov), cyl = cylindrical (hfov)."""
    if proj == "flat":
        px = ((np.arange(w) + 0.5) / w * 2 - 1) * math.tan(math.radians(hfov_deg) / 2)
        py = ((np.arange(h) + 0.5) / h * 2 - 1) * math.tan(math.radians(hfov_deg) / 2) * (h / w)
        PX, PY = np.meshgrid(px, py)
        d = np.stack([PX, PY, np.ones_like(PX)], -1)
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        return d.reshape(-1, 3).astype(np.float32)
    if proj == "cylsg":
        # horizon straight (centre row), verticals straight, vertical range compressed stereographically
        lon = ((np.arange(w) + 0.5) / w * 2 - 1) * math.radians(hfov_deg) / 2
        py = ((np.arange(h) + 0.5) / h * 2 - 1) * math.radians(hfov_deg) / 2 * (h / w)
        LON, PY = np.meshgrid(lon, py)
        LAT = -2 * np.arctan(PY / 2)                       # py down -> lat negative
        d = np.stack([np.sin(LON) * np.cos(LAT), -np.sin(LAT), np.cos(LON) * np.cos(LAT)], -1)
        return d.reshape(-1, 3).astype(np.float32)
    if proj == "cyl":
        lon = ((np.arange(w) + 0.5) / w * 2 - 1) * math.radians(hfov_deg) / 2
        # vertical: tangent scale so the aspect matches a rectilinear centre
        py = ((np.arange(h) + 0.5) / h * 2 - 1) * math.radians(hfov_deg) / 2 * (h / w)
        LON, PY = np.meshgrid(lon, py)
        d = np.stack([np.sin(LON), PY, np.cos(LON)], -1)
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        return d.reshape(-1, 3).astype(np.float32)
    px = (np.arange(w) + 0.5) / w * 2 - 1
    py = ((np.arange(h) + 0.5) / h * 2 - 1) * (h / w)
    PX, PY = np.meshgrid(px, py)
    r = np.hypot(PX, PY)
    r_diag = math.hypot(1.0, h / w)
    f = r_diag / (2 * math.tan(math.radians(dfov_deg) / 4))
    th = 2 * np.arctan(r / (2 * f))
    lr = np.where(r > 0, r, 1)
    d = np.stack([np.sin(th) * PX / lr, np.sin(th) * PY / lr, np.cos(th)], -1)
    return d.reshape(-1, 3).astype(np.float32)


def basis(F):
    F = F / np.linalg.norm(F)
    Rt = np.cross(F, UP_WORLD); n = np.linalg.norm(Rt)
    if n < 1e-6: Rt = np.array([1.0, 0, 0])
    else: Rt /= n
    Dn = np.cross(F, Rt)
    return np.stack([Rt, Dn, F], 1)   # columns: right, down, forward


def render_frame(front, back, R, F_world, vd, w, h, roll_lock=True):
    B = basis(F_world) if roll_lock else None
    d_world = vd @ B.T
    d_cam = d_world @ R           # R^T applied: d_cam = R^T d_world  -> (N,3) @ R
    return insta.sample(front, back, d_cam.astype(np.float32)).reshape(h, w, 3)


def calib(clip, out_png, times=(5.0, 20.0, 35.0), size=(320, 180), dfov=200, gain=0.003, only=None):
    t, gyro, acc = load_imu(clip)
    maps = mapping_matrices()
    if only: maps = {k: v for k, v in maps.items() if k in only}
    frames = {tt: (insta.decode_frame(clip, tt, insta.FRONT), insta.decode_frame(clip, tt, insta.BACK)) for tt in times}
    vd = view_dirs(size[0], size[1], dfov)
    rows = []
    for name, M in maps.items():
        Rs = integrate(t, gyro, acc, M, gain=gain)
        tiles = []
        for tt in times:
            i = np.clip(np.searchsorted(t, tt), 0, len(t) - 1)
            R = Rs[i]
            F = R @ STICK_CAM
            img = render_frame(frames[tt][0], frames[tt][1], R, F, vd, size[0], size[1])
            tiles.append(img)
        row = np.concatenate(tiles, 1)
        # label strip: write name into a black bar via ffmpeg later; keep simple: prefix column of code
        rows.append((name, row))
    # 24 rows -> 4 columns x 6 rows grid, each cell = row of 3 tiles
    names = [n for n, _ in rows]
    cells = [r for _, r in rows]
    cols = 1
    grid_rows = []
    for i in range(0, len(cells), cols):
        grid_rows.append(np.concatenate(cells[i:i + cols], 1))
    grid = np.concatenate(grid_rows, 0)
    insta.write_png(out_png, grid)
    json.dump(names, open(out_png + ".names.json", "w"))
    print("wrote", out_png, "order (row-major, %d per row):" % cols, names)


def plan_views(t, Rs, n_frames, offset, smooth_s, blend, tilt_deg, level, raise_cut=True):
    """Per-frame (R, F) pairs plus a mode flag. Mode 'body' = third-person along the stick;
    'face' = the camera has been raised (stick direction pitched up), so look at Kevin's face."""
    Rf = per_frame_R(t, Rs, n_frames, offset=offset)
    F_all = np.einsum("nij,j->ni", Rf, STICK_CAM)
    F_fast = smooth_dirs(F_all, int(round(0.15 * FPS)) | 1)
    F_slow = smooth_dirs(F_all, int(round(smooth_s * FPS)) | 1)
    F_sm = (1 - blend) * F_fast + blend * F_slow
    F_sm /= np.linalg.norm(F_sm, axis=1, keepdims=True)
    # raise detection: stick pitched above -25 deg (world y is down, so F_y > -sin(25)) for > 0.5 s
    mode = np.array(["body"] * n_frames, dtype=object)
    if raise_cut:
        up = F_slow[:, 1] > -math.sin(math.radians(25))
        run = 0
        for i in range(n_frames):
            run = run + 1 if up[i] else 0
            if run >= int(0.5 * FPS): mode[i - run + 1:i + 1] = "face"
    if level:
        F_sm[:, 1] = 0.0
        F_sm /= np.linalg.norm(F_sm, axis=1, keepdims=True).clip(1e-6)
    if tilt_deg:
        for i in range(n_frames):
            B = basis(F_sm[i]); ax = B[:, 0]
            F_sm[i] = skew_exp(ax * math.radians(-tilt_deg)) @ F_sm[i]
    # face mode: look along the stick again but with no level/tilt (camera is raised, face is near the stick line)
    for i in range(n_frames):
        if mode[i] == "face":
            F_sm[i] = F_fast[i]
    return Rf, F_sm, mode


def _render_one(args):
    front, back, R, F, mode, w, h, vd_body, vd_face = args
    vd = vd_face if mode == "face" else vd_body
    return render_frame(front, back, R, F, vd, w, h, True)


def render(clip, out_mp4, map_name, dfov, start, end, size, smooth_s=1.0, tilt_deg=0.0, roll_lock=True,
           gain=0.0003, offset=0.0, blend=0.5, still=None, proj="sg", hfov=120.0, level=False,
           workers=4, raise_cut=True, video_only=False):
    t, gyro, acc = load_imu(clip)
    M = mapping_matrices()[map_name]
    Rs = integrate(t, gyro, acc, M, gain=gain)
    dur = float(subprocess.run([os.path.expanduser("~/tools/bin/ffprobe"), "-v", "error", "-show_entries",
                                "format=duration", "-of", "csv=p=0", clip], capture_output=True, text=True).stdout)
    end = min(end if end else dur, dur)
    n0, n1 = int(round(start * FPS)), int(round(end * FPS))
    Rf, F_sm, mode = plan_views(t, Rs, n1, offset, smooth_s, blend, tilt_deg, level, raise_cut)
    w, h = size
    vd_body = view_dirs(w, h, dfov, proj, hfov)
    vd_face = view_dirs(w, h, 120.0, "flat", 100.0)     # tighter, natural view for the raised-camera sign-off
    if still is not None:
        k = int(round(still * FPS))
        fr0 = insta.decode_frame(clip, still, insta.FRONT); bk0 = insta.decode_frame(clip, still, insta.BACK)
        insta.write_png(out_mp4, _render_one((fr0, bk0, Rf[k], F_sm[k], mode[k], w, h, vd_body, vd_face)))
        print("still", out_mp4, "mode", mode[k]); return
    if workers > 1:
        # time-sliced parallelism: each worker decodes and renders its own slice (no frames cross
        # process boundaries), then the slices are concatenated and the clip audio muxed back in.
        import tempfile, shutil
        tmp = tempfile.mkdtemp(prefix="ce360_")
        total = end - start; per = total / workers
        procs, parts = [], []
        for i in range(workers):
            a = start + i * per; b = end if i == workers - 1 else start + (i + 1) * per
            part = os.path.join(tmp, "part%02d.mp4" % i); parts.append(part)
            cmd = [sys.executable, os.path.abspath(__file__), "render", clip, part, "--map", map_name,
                   "--dfov", str(dfov), "--start", "%.6f" % a, "--end", "%.6f" % b, "--size", "%dx%d" % (w, h),
                   "--smooth", str(smooth_s), "--tilt", str(tilt_deg), "--gain", str(gain), "--offset", str(offset),
                   "--blend", str(blend), "--proj", proj, "--hfov", str(hfov), "--workers", "1", "--video-only"]
            if level: cmd.append("--level")
            if not raise_cut: cmd.append("--no-raise-cut")
            procs.append(subprocess.Popen(cmd, stdout=subprocess.DEVNULL))
        for p in procs:
            if p.wait() != 0: raise SystemExit("a render slice failed")
        lst = os.path.join(tmp, "parts.txt")
        open(lst, "w").write("".join("file '%s'\n" % p for p in parts))
        subprocess.run([insta.FFMPEG, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-ss", str(start), "-i", clip, "-map", "0:v", "-map", "1:a:0", "-t", str(total),
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out_mp4], check=True)
        shutil.rmtree(tmp, ignore_errors=True)
        print("rendered", out_mp4, "slices", workers); return
    enc_cmd = [insta.FFMPEG, "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (w, h), "-r", str(FPS), "-i", "-"]
    if video_only:
        enc_cmd += ["-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p", out_mp4]
    else:
        enc_cmd += ["-ss", str(start), "-i", clip, "-map", "0:v", "-map", "1:a:0", "-t", str(end - start),
                    "-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out_mp4]
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)
    fr = insta.frame_stream(clip, insta.FRONT, start=start, end=end)
    bk = insta.frame_stream(clip, insta.BACK, start=start, end=end)
    n = n0; faces = 0
    for front, back in zip(fr, bk):
        if n >= n1: break
        if mode[n] == "face": faces += 1
        enc.stdin.write(_render_one((front, back, Rf[n], F_sm[n], mode[n], w, h, vd_body, vd_face)).tobytes())
        n += 1
    enc.stdin.close(); enc.wait()
    print("rendered", out_mp4, "frames", n - n0, "face-mode frames", faces)


def sync(clip, map_name, start=5.0, end=15.0, gain=0.0003, offsets=None, lens=720, size=(320, 180), dfov=200, smooth_s=1.0):
    """Score IMU-to-video time offsets by residual frame-to-frame motion of a low-res stabilised render."""
    offsets = offsets if offsets is not None else [round(x, 3) for x in np.arange(-0.12, 0.121, 0.02)]
    t, gyro, acc = load_imu(clip)
    Rs = integrate(t, gyro, acc, mapping_matrices()[map_name], gain=gain)
    fr = list(insta.frame_stream(clip, insta.FRONT, w=lens, h=lens, start=start, end=end))
    bk = list(insta.frame_stream(clip, insta.BACK, w=lens, h=lens, start=start, end=end))
    n0 = int(round(start * FPS)); n = min(len(fr), len(bk))
    vd = view_dirs(size[0], size[1], dfov)
    results = []
    for off in offsets:
        Rf = per_frame_R(t, Rs, n0 + n, offset=off)
        F_sm = smooth_dirs(np.einsum("nij,j->ni", Rf, STICK_CAM), int(round(smooth_s * FPS)) | 1)
        prev = None; score = 0.0
        for k in range(n):
            img = render_frame(fr[k], bk[k], Rf[n0 + k], F_sm[n0 + k], vd, size[0], size[1]).astype(np.float32)
            if prev is not None: score += float(np.abs(img - prev).mean())
            prev = img
        results.append((off, score / max(1, n - 1)))
        print("offset %+.3f s  motion %.3f" % results[-1], flush=True)
    best = min(results, key=lambda r: r[1])
    print("BEST offset", best)
    return best


def selftest():
    maps = mapping_matrices(); assert len(maps) == 24 and "z-yx" in maps
    M = maps["z-yx"]; assert round(float(np.linalg.det(M))) == 1
    vd = view_dirs(96, 54, 200); assert vd.shape == (96 * 54, 3) and abs(float(np.linalg.norm(vd, axis=1).max()) - 1) < 1e-5
    for proj in ("flat", "cyl", "cylsg"):
        v = view_dirs(64, 36, 200, proj, 120.0); assert v.shape == (64 * 36, 3)
    d = smooth_dirs(np.tile([[0.0, 0.0, 1.0]], (50, 1)), 9); assert np.allclose(d[:, 2], 1.0)
    B = basis(np.array([0.0, 0.0, 1.0])); assert np.allclose(B[:, 0], [1, 0, 0]) and np.allclose(B[:, 1], [0, 1, 0])
    assert np.allclose(skew_exp(np.zeros(3)), np.eye(3))
    # raise detection: stick pointing down for 2 s then level for 2 s -> face mode in the second half
    n = int(4 * FPS); t = np.arange(n) / FPS
    Rs = np.repeat(np.eye(3)[None], n, 0); tt = np.arange(0, 4, 0.001)
    Rall = np.repeat(np.eye(3)[None], len(tt), 0)
    Rf, F, mode = plan_views(tt, Rall, n, 0.0, 1.0, 0.5, 0.0, False, raise_cut=False)
    assert (mode == "body").all()
    print("stab selftest ok")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        selftest(); sys.exit(0)
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("clip"); ap.add_argument("out")
    ap.add_argument("--map", default="xyz"); ap.add_argument("--dfov", type=float, default=200)
    ap.add_argument("--start", type=float, default=0.0); ap.add_argument("--end", type=float, default=None)
    ap.add_argument("--size", default="1920x1080"); ap.add_argument("--smooth", type=float, default=1.0)
    ap.add_argument("--tilt", type=float, default=0.0); ap.add_argument("--times", default="5,20,35")
    ap.add_argument("--no-roll-lock", action="store_true"); ap.add_argument("--gain", type=float, default=0.0003); ap.add_argument("--offset", type=float, default=0.0); ap.add_argument("--blend", type=float, default=0.5); ap.add_argument("--still", type=float, default=None); ap.add_argument("--proj", default="sg"); ap.add_argument("--hfov", type=float, default=120.0); ap.add_argument("--level", action="store_true"); ap.add_argument("--workers", type=int, default=4); ap.add_argument("--no-raise-cut", action="store_true"); ap.add_argument("--video-only", action="store_true"); ap.add_argument("--only", default=None)
    a = ap.parse_args()
    if a.mode == "calib":
        calib(a.clip, a.out, times=tuple(float(x) for x in a.times.split(",")), dfov=a.dfov, gain=a.gain, only=(a.only.split(",") if a.only else None))
    elif a.mode == "sync":
        sync(a.clip, a.map, start=a.start, end=(a.end or a.start + 10), gain=a.gain, dfov=a.dfov, smooth_s=a.smooth)
    else:
        w, h = (int(x) for x in a.size.split("x"))
        render(a.clip, a.out, a.map, a.dfov, a.start, a.end, (w, h), a.smooth, a.tilt, not a.no_roll_lock, a.gain, a.offset, a.blend, a.still, a.proj, a.hfov, a.level, a.workers, not a.no_raise_cut, a.video_only)
