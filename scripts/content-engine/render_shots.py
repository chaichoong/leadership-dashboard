#!/usr/bin/env python3
"""Spike renderer: Insta360 .insv (two fisheye streams) -> 16:9 flat edit from a shot list.

Shot list JSON: {"clip": path, "out": path, "audio_stream": 2,
  "shots": [{"start": 0, "end": 21, "yaw": 13, "pitch": -45, "roll": 0,
             "z_from": 1.0, "z_to": 1.18}, ...],
  "xfade": 0.5}
Each shot is a fixed look direction (v360 dfisheye->flat, wide 118 deg) with a linear zoom
(zoompan) from z_from to z_to. Shots are joined with dissolves of `xfade` seconds; consecutive
shots overlap by that amount (shot N+1 starts xfade seconds before shot N ends).
"""
import json, os, subprocess, sys

FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg")
FPS = 24
WIDE_W, WIDE_H = 2560, 1440
OUT_W, OUT_H = 1920, 1080


def build_graph(spec):
    shots = spec["shots"]
    xf = float(spec.get("xfade", 0.5))
    n = len(shots)
    parts = ["[0:0][0:1]hstack=inputs=2,split=%d%s" % (n, "".join("[df%d]" % i for i in range(n)))]
    for i, s in enumerate(shots):
        start, end = float(s["start"]), float(s["end"])
        dur = end - start
        frames = max(1, int(round(dur * FPS)))
        z0, z1 = float(s.get("z_from", 1.0)), float(s.get("z_to", 1.0))
        parts.append(
            "[df%d]trim=%.3f:%.3f,setpts=PTS-STARTPTS,"
            "v360=dfisheye:%s:ih_fov=190:iv_fov=190:%s:w=%d:h=%d:"
            "yaw=%s:pitch=%s:roll=%s,"
            "zoompan=z='%.4f+(%.4f)*on/%d':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=%dx%d:fps=%d[s%d]"
            % (i, start, end, s.get("proj", "flat"),
               ("d_fov=%s" % s["d_fov"]) if "d_fov" in s else "h_fov=118:v_fov=76",
               WIDE_W, WIDE_H, s.get("yaw", 0), s.get("pitch", 0), s.get("roll", 0),
               z0, z1 - z0, frames, OUT_W, OUT_H, FPS, i))
    # chain xfades: offset = cumulative length of the left side minus xf
    prev = "s0"
    total = float(shots[0]["end"]) - float(shots[0]["start"])
    for i in range(1, n):
        dur = float(shots[i]["end"]) - float(shots[i]["start"])
        offset = total - xf
        label = "v" if i == n - 1 else "x%d" % i
        parts.append("[%s][s%d]xfade=transition=fade:duration=%.3f:offset=%.3f[%s]" % (prev, i, xf, offset, label))
        total = offset + dur
        prev = label
    if n == 1:
        parts.append("[s0]null[v]")
    return ";\n".join(parts)


def main(path):
    spec = json.load(open(path))
    graph = build_graph(spec)
    cmd = [FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", spec["clip"],
           "-filter_complex", graph, "-map", "[v]", "-map", "0:%d" % spec.get("audio_stream", 2),
           "-c:v", "h264_videotoolbox", "-b:v", "12M", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", spec["out"]]
    print(graph)
    subprocess.run(cmd, check=True)
    print("rendered", spec["out"])


if __name__ == "__main__":
    main(sys.argv[1])
