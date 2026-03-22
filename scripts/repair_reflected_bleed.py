# python3 -m venv .venv
# source .venv/bin/activate
# pip install pillow numpy

# python repair_reflected_bleed.py \
#   ./reflected \
#   ./repaired \
#   --threshold 24 \
#   --sample-depth 12 \
#   --inset-along-edge 40

#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image

# Default sizes for your current pipeline
DEFAULT_FINAL_W = 2200
DEFAULT_FINAL_H = 3000
DEFAULT_TRIM_W = 2000
DEFAULT_TRIM_H = 2800

VALID_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def rgb_dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a.astype(np.float32) - b.astype(np.float32)))


def mean_rgb(region: Image.Image) -> np.ndarray:
    arr = np.asarray(region.convert("RGB"), dtype=np.float32)
    return arr.reshape(-1, 3).mean(axis=0)


def crop_strip(
    img: Image.Image,
    side: str,
    trim_box: tuple[int, int, int, int],
    inset_along_edge: int,
    sample_depth: int,
) -> Image.Image:
    left, top, right, bottom = trim_box

    if side == "top":
        return img.crop(
            (
                left + inset_along_edge,
                top,
                right - inset_along_edge,
                min(bottom, top + sample_depth),
            )
        )
    if side == "bottom":
        return img.crop(
            (
                left + inset_along_edge,
                max(top, bottom - sample_depth),
                right - inset_along_edge,
                bottom,
            )
        )
    if side == "left":
        return img.crop(
            (
                left,
                top + inset_along_edge,
                min(right, left + sample_depth),
                bottom - inset_along_edge,
            )
        )
    if side == "right":
        return img.crop(
            (
                max(left, right - sample_depth),
                top + inset_along_edge,
                right,
                bottom - inset_along_edge,
            )
        )
    raise ValueError(f"Unknown side: {side}")


def compute_border_stats(
    img: Image.Image,
    trim_box: tuple[int, int, int, int],
    inset_along_edge: int,
    sample_depth: int,
) -> tuple[dict[str, np.ndarray], np.ndarray, float]:
    side_means = {}
    for side in ("top", "bottom", "left", "right"):
        region = crop_strip(img, side, trim_box, inset_along_edge, sample_depth)
        side_means[side] = mean_rgb(region)

    vals = list(side_means.values())
    max_pairwise = 0.0
    for i in range(len(vals)):
        for j in range(i + 1, len(vals)):
            max_pairwise = max(max_pairwise, rgb_dist(vals[i], vals[j]))

    avg = np.mean(np.stack(vals, axis=0), axis=0)
    return side_means, avg, max_pairwise


def repaint_bleed_bands(
    img: Image.Image,
    trim_box: tuple[int, int, int, int],
    fill_rgb: np.ndarray,
) -> Image.Image:
    out = img.convert("RGBA").copy()
    arr = np.asarray(out).copy()

    left, top, right, bottom = trim_box
    fill = np.array(
        [int(round(fill_rgb[0])), int(round(fill_rgb[1])), int(round(fill_rgb[2])), 255],
        dtype=np.uint8,
    )

    # Top bleed
    if top > 0:
        arr[:top, :, :] = fill
    # Bottom bleed
    if bottom < arr.shape[0]:
        arr[bottom:, :, :] = fill
    # Left bleed
    if left > 0:
        arr[:, :left, :] = fill
    # Right bleed
    if right < arr.shape[1]:
        arr[:, right:, :] = fill

    return Image.fromarray(arr, mode="RGBA")


def process_file(
    src_path: Path,
    dst_path: Path,
    trim_w: int,
    trim_h: int,
    inset_along_edge: int,
    sample_depth: int,
    threshold: float,
    force: bool,
    dry_run: bool,
) -> None:
    img = Image.open(src_path)
    w, h = img.size

    if w < trim_w or h < trim_h:
        print(f"SKIP {src_path.name}: image smaller than trim size ({w}x{h})")
        return

    bleed_x = (w - trim_w) // 2
    bleed_y = (h - trim_h) // 2

    trim_box = (bleed_x, bleed_y, bleed_x + trim_w, bleed_y + trim_h)

    side_means, avg_rgb, max_pairwise = compute_border_stats(
        img=img,
        trim_box=trim_box,
        inset_along_edge=inset_along_edge,
        sample_depth=sample_depth,
    )

    should_repair = force or (max_pairwise <= threshold)

    means_str = " ".join(
        f"{k}=({int(v[0])},{int(v[1])},{int(v[2])})" for k, v in side_means.items()
    )
    avg_str = f"avg=({int(avg_rgb[0])},{int(avg_rgb[1])},{int(avg_rgb[2])})"

    if not should_repair:
        print(
            f"LEAVE {src_path.name}: max_dist={max_pairwise:.2f} > threshold={threshold:.2f} "
            f"{avg_str} {means_str}"
        )
        if not dry_run:
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            img.save(dst_path)
        return

    print(
        f"REPAIR {src_path.name}: max_dist={max_pairwise:.2f} <= threshold={threshold:.2f} "
        f"{avg_str} {means_str}"
    )

    if dry_run:
        return

    repaired = repaint_bleed_bands(img, trim_box, avg_rgb)
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    save_kwargs = {}
    if src_path.suffix.lower() in {".jpg", ".jpeg"}:
        repaired = repaired.convert("RGB")
        save_kwargs["quality"] = 95
    else:
        save_kwargs["compress_level"] = 6

    repaired.save(dst_path, **save_kwargs)


def iter_images(path: Path) -> Iterable[Path]:
    if path.is_file():
        if path.suffix.lower() in VALID_EXTS:
            yield path
        return

    for p in path.rglob("*"):
        if p.is_file() and p.suffix.lower() in VALID_EXTS:
            yield p


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Repair reflected bleed on already padded card images by repainting bleed bands with a sampled border color."
    )
    parser.add_argument("input", help="Input file or directory")
    parser.add_argument("output", help="Output file or directory")
    parser.add_argument("--trim-width", type=int, default=DEFAULT_TRIM_W)
    parser.add_argument("--trim-height", type=int, default=DEFAULT_TRIM_H)
    parser.add_argument(
        "--threshold",
        type=float,
        default=24.0,
        help="Max allowed pairwise RGB distance between sampled side colors to consider border uniform",
    )
    parser.add_argument(
        "--sample-depth",
        type=int,
        default=12,
        help="Thickness in pixels of sampled strips just inside trim edge",
    )
    parser.add_argument(
        "--inset-along-edge",
        type=int,
        default=40,
        help="Inset from corners when sampling strips to avoid corner contamination",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Always repaint bleed using average sampled border color, even if sides differ",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print decisions without writing files",
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if input_path.is_file():
        if output_path.exists() and output_path.is_dir():
            dst = output_path / input_path.name
        else:
            dst = output_path
        process_file(
            src_path=input_path,
            dst_path=dst,
            trim_w=args.trim_width,
            trim_h=args.trim_height,
            inset_along_edge=args.inset_along_edge,
            sample_depth=args.sample_depth,
            threshold=args.threshold,
            force=args.force,
            dry_run=args.dry_run,
        )
        return

    for src in iter_images(input_path):
        rel = src.relative_to(input_path)
        dst = output_path / rel
        process_file(
            src_path=src,
            dst_path=dst,
            trim_w=args.trim_width,
            trim_h=args.trim_height,
            inset_along_edge=args.inset_along_edge,
            sample_depth=args.sample_depth,
            threshold=args.threshold,
            force=args.force,
            dry_run=args.dry_run,
        )


if __name__ == "__main__":
    main()
