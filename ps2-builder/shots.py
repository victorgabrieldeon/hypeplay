#!/usr/bin/env python3
"""The last screenshots of the builder's test runs, for the library: how far the server got into the game.

    shots.py <shots dir> <out dir> <count>

port.sh's runs leave frame_NNNNN.ppm in games/<id>/shots; the last <count> by name become <out>/01.webp, 02.webp...
Prints how many it wrote (0 when there were none)."""
import pathlib, sys

from PIL import Image


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 64
    src, out, count = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
    frames = sorted(src.glob("frame_*.ppm"))[-count:] if src.is_dir() else []
    out.mkdir(parents=True, exist_ok=True)
    for n, frame in enumerate(frames, 1):
        with Image.open(frame) as image:
            image.convert("RGB").save(out / f"{n:02d}.webp", "WEBP", quality=80)
    print(len(frames))
    return 0


if __name__ == "__main__":
    sys.exit(main())
