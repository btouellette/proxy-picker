# python3 -m venv .venv
# source .venv/bin/activate
# pip install pillow numpy opencv-python

# python repair_reflected_bleed.py \
#   ./reflected \
#   ./repaired \
#   --threshold 24 \
#   --sample-depth 12 \
#   --inset-along-edge 40

#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
from PIL import Image, ImageFilter

VALID_EXTS = {".png", ".jpg", ".jpeg", ".webp"}

DEFAULT_TRIM_W = 2000
DEFAULT_TRIM_H = 2800

DEFAULT_THRESHOLD = 24.0
DEFAULT_SAMPLE_DEPTH = 12
DEFAULT_INSET_ALONG_EDGE = 40

DEFAULT_CORNER_RADIUS = 58
DEFAULT_CORNER_PADDING = 24
DEFAULT_RING_WIDTH = 14

DEFAULT_PATCH_OFFSET = 18
DEFAULT_FEATHER = 2.5
DEFAULT_FULLART_MASK_DILATE = 10


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
            (left + inset_along_edge, top, right - inset_along_edge, min(bottom, top + sample_depth))
        )
    if side == "bottom":
        return img.crop(
            (left + inset_along_edge, max(top, bottom - sample_depth), right - inset_along_edge, bottom)
        )
    if side == "left":
        return img.crop(
            (left, top + inset_along_edge, min(right, left + sample_depth), bottom - inset_along_edge)
        )
    if side == "right":
        return img.crop(
            (max(left, right - sample_depth), top + inset_along_edge, right, bottom - inset_along_edge)
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
    arr_rgba: np.ndarray,
    trim_box: tuple[int, int, int, int],
    fill_rgba: np.ndarray,
) -> None:
    left, top, right, bottom = trim_box
    if top > 0:
        arr_rgba[:top, :, :] = fill_rgba
    if bottom < arr_rgba.shape[0]:
        arr_rgba[bottom:, :, :] = fill_rgba
    if left > 0:
        arr_rgba[:, :left, :] = fill_rgba
    if right < arr_rgba.shape[1]:
        arr_rgba[:, right:, :] = fill_rgba


def repaint_trim_corners_bordered(
    arr_rgba: np.ndarray,
    trim_box: tuple[int, int, int, int],
    fill_rgba: np.ndarray,
    radius: int,
    padding: int,
    ring_width: int,
) -> None:
    left, top, right, bottom = trim_box
    r = min(radius + padding, (right - left) // 2, (bottom - top) // 2)
    ring_width = max(0, min(ring_width, r))
    inner_r = max(0, r - ring_width)

    yy, xx = np.mgrid[0:r, 0:r]

    def apply_corner(y0: int, y1: int, x0: int, x1: int, cx: int, cy: int) -> None:
        sub = arr_rgba[y0:y1, x0:x1]
        dist2 = (xx - cx) ** 2 + (yy - cy) ** 2
        cutout_mask = dist2 >= r * r
        ring_mask = (dist2 < r * r) & (dist2 >= inner_r * inner_r)
        sub[cutout_mask | ring_mask] = fill_rgba

    apply_corner(top, top + r, left, left + r, r - 1, r - 1)
    apply_corner(top, top + r, right - r, right, 0, r - 1)
    apply_corner(bottom - r, bottom, left, left + r, r - 1, 0)
    apply_corner(bottom - r, bottom, right - r, right, 0, 0)


def build_fullart_cutout_mask_np(
    size: tuple[int, int],
    trim_box: tuple[int, int, int, int],
    radius: int,
    padding: int,
) -> np.ndarray:
    w, h = size
    left, top, right, bottom = trim_box
    r = min(radius + padding, (right - left) // 2, (bottom - top) // 2)

    mask = np.zeros((h, w), dtype=np.uint8)
    yy, xx = np.mgrid[0:r, 0:r]

    def apply_corner(y0: int, y1: int, x0: int, x1: int, cx: int, cy: int) -> None:
        dist2 = (xx - cx) ** 2 + (yy - cy) ** 2
        cutout_mask = (dist2 >= r * r).astype(np.uint8) * 255
        current = mask[y0:y1, x0:x1]
        mask[y0:y1, x0:x1] = np.maximum(current, cutout_mask)

    apply_corner(top, top + r, left, left + r, r - 1, r - 1)
    apply_corner(top, top + r, right - r, right, 0, r - 1)
    apply_corner(bottom - r, bottom, left, left + r, r - 1, 0)
    apply_corner(bottom - r, bottom, right - r, right, 0, 0)

    return mask


def repair_fullart_interior_by_patch(
    img: Image.Image,
    trim_box: tuple[int, int, int, int],
    radius: int,
    padding: int,
    patch_offset: int,
    feather: float,
    mask_dilate: int,
) -> Image.Image:
    base = img.convert("RGB")
    out = base.copy()

    left, top, right, bottom = trim_box
    r = min(radius + padding, (right - left) // 2, (bottom - top) // 2)

    full_mask = build_fullart_cutout_mask_np(base.size, trim_box, radius, padding)
    if mask_dilate > 0:
        kernel = np.ones((3, 3), np.uint8)
        full_mask = cv2.dilate(full_mask, kernel, iterations=mask_dilate)

    def mask_crop(box: tuple[int, int, int, int]) -> Image.Image:
        x0, y0, x1, y1 = box
        m = Image.fromarray(full_mask[y0:y1, x0:x1], mode="L")
        if feather > 0:
            m = m.filter(ImageFilter.GaussianBlur(radius=feather))
        return m

    # top-left
    src = base.crop((left + patch_offset, top + patch_offset, left + patch_offset + r, top + patch_offset + r))
    src = src.transpose(Image.Transpose.FLIP_LEFT_RIGHT).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    box = (left, top, left + r, top + r)
    out.paste(src, (left, top), mask_crop(box))

    # top-right
    src = base.crop((right - patch_offset - r, top + patch_offset, right - patch_offset, top + patch_offset + r))
    src = src.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    box = (right - r, top, right, top + r)
    out.paste(src, (right - r, top), mask_crop(box))

    # bottom-left
    src = base.crop((left + patch_offset, bottom - patch_offset - r, left + patch_offset + r, bottom - patch_offset))
    src = src.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    box = (left, bottom - r, left + r, bottom)
    out.paste(src, (left, bottom - r), mask_crop(box))

    # bottom-right
    src = base.crop((right - patch_offset - r, bottom - patch_offset - r, right - patch_offset, bottom - patch_offset))
    box = (right - r, bottom - r, right, bottom)
    out.paste(src, (right - r, bottom - r), mask_crop(box))

    return out


def reflect_repaired_interior_outward(
    img: Image.Image,
    trim_box: tuple[int, int, int, int],
    radius: int,
    padding: int,
) -> Image.Image:
    base = img.convert("RGB")
    out = base.copy()

    left, top, right, bottom = trim_box
    r = min(radius + padding, (right - left) // 2, (bottom - top) // 2)

    # --- Top-left interior corner ---
    interior = out.crop((left, top, left + r, top + r))

    # left of trim edge, same vertical band
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        (left - r, top),
    )
    # above trim edge, same horizontal band
    out.paste(
        interior.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (left, top - r),
    )
    # diagonal exterior corner
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT).transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (left - r, top - r),
    )

    # --- Top-right interior corner ---
    interior = out.crop((right - r, top, right, top + r))

    # right of trim edge
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        (right, top),
    )
    # above trim edge
    out.paste(
        interior.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (right - r, top - r),
    )
    # diagonal exterior corner
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT).transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (right, top - r),
    )

    # --- Bottom-left interior corner ---
    interior = out.crop((left, bottom - r, left + r, bottom))

    # left of trim edge
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        (left - r, bottom - r),
    )
    # below trim edge
    out.paste(
        interior.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (left, bottom),
    )
    # diagonal exterior corner
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT).transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (left - r, bottom),
    )

    # --- Bottom-right interior corner ---
    interior = out.crop((right - r, bottom - r, right, bottom))

    # right of trim edge
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        (right, bottom - r),
    )
    # below trim edge
    out.paste(
        interior.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (right - r, bottom),
    )
    # diagonal exterior corner
    out.paste(
        interior.transpose(Image.Transpose.FLIP_LEFT_RIGHT).transpose(Image.Transpose.FLIP_TOP_BOTTOM),
        (right, bottom),
    )

    return out


def save_image(img: Image.Image, dst_path: Path) -> None:
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    ext = dst_path.suffix.lower()
    img = img.convert("RGB")

    if ext in {".jpg", ".jpeg"}:
        img.save(dst_path, quality=95)
    elif ext == ".png":
        img.save(dst_path, compress_level=6)
    else:
        img.save(dst_path)


def process_file(
    src_path: Path,
    dst_path: Path,
    trim_w: int,
    trim_h: int,
    threshold: float,
    sample_depth: int,
    inset_along_edge: int,
    corner_radius: int,
    corner_padding: int,
    ring_width: int,
    patch_offset: int,
    feather: float,
    fullart_mask_dilate: int,
    dry_run: bool,
) -> None:
    img = Image.open(src_path)
    w, h = img.size

    if w < trim_w or h < trim_h:
        print(f"SKIP    {src_path.name}: image smaller than trim size ({w}x{h})")
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

    means_str = " ".join(
        f"{k}=({int(v[0])},{int(v[1])},{int(v[2])})" for k, v in side_means.items()
    )
    avg_str = f"avg=({int(avg_rgb[0])},{int(avg_rgb[1])},{int(avg_rgb[2])})"

    uniform_border = max_pairwise <= threshold

    if uniform_border:
        print(
            f"BORDER  {src_path.name}: max_dist={max_pairwise:.2f} "
            f"{avg_str} radius={corner_radius} pad={corner_padding} ring={ring_width} {means_str}"
        )
        if dry_run:
            return

        rgba = np.asarray(img.convert("RGBA")).copy()
        fill_rgba = np.array(
            [int(round(avg_rgb[0])), int(round(avg_rgb[1])), int(round(avg_rgb[2])), 255],
            dtype=np.uint8,
        )
        repaint_bleed_bands(rgba, trim_box, fill_rgba)
        repaint_trim_corners_bordered(
            rgba,
            trim_box,
            fill_rgba,
            radius=corner_radius,
            padding=corner_padding,
            ring_width=ring_width,
        )
        repaired = Image.fromarray(rgba, mode="RGBA").convert("RGB")
        save_image(repaired, dst_path)
        return

    print(
        f"FULLART {src_path.name}: max_dist={max_pairwise:.2f} > threshold={threshold:.2f} "
        f"radius={corner_radius} pad={corner_padding} patch_offset={patch_offset} "
        f"feather={feather} dilate={fullart_mask_dilate} {means_str}"
    )
    if dry_run:
        return

    repaired = repair_fullart_interior_by_patch(
        img=img,
        trim_box=trim_box,
        radius=corner_radius,
        padding=corner_padding,
        patch_offset=patch_offset,
        feather=feather,
        mask_dilate=fullart_mask_dilate,
    )
    repaired = reflect_repaired_interior_outward(
        repaired,
        trim_box=trim_box,
        radius=corner_radius,
        padding=corner_padding,
    )
    save_image(repaired, dst_path)


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
        description="Auto-route bordered cards to solid-color corner repair and full-art cards to patch-copy corner repair plus exterior reflection."
    )
    parser.add_argument("input", help="Input file or directory")
    parser.add_argument("output", help="Output file or directory")
    parser.add_argument("--trim-width", type=int, default=DEFAULT_TRIM_W)
    parser.add_argument("--trim-height", type=int, default=DEFAULT_TRIM_H)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--sample-depth", type=int, default=DEFAULT_SAMPLE_DEPTH)
    parser.add_argument("--inset-along-edge", type=int, default=DEFAULT_INSET_ALONG_EDGE)
    parser.add_argument("--corner-radius", type=int, default=DEFAULT_CORNER_RADIUS)
    parser.add_argument("--corner-padding", type=int, default=DEFAULT_CORNER_PADDING)
    parser.add_argument("--ring-width", type=int, default=DEFAULT_RING_WIDTH)
    parser.add_argument("--patch-offset", type=int, default=DEFAULT_PATCH_OFFSET)
    parser.add_argument("--feather", type=float, default=DEFAULT_FEATHER)
    parser.add_argument("--fullart-mask-dilate", type=int, default=DEFAULT_FULLART_MASK_DILATE)
    parser.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    if input_path.is_file():
        dst = output_path / input_path.name if output_path.exists() and output_path.is_dir() else output_path
        process_file(
            src_path=input_path,
            dst_path=dst,
            trim_w=args.trim_width,
            trim_h=args.trim_height,
            threshold=args.threshold,
            sample_depth=args.sample_depth,
            inset_along_edge=args.inset_along_edge,
            corner_radius=args.corner_radius,
            corner_padding=args.corner_padding,
            ring_width=args.ring_width,
            patch_offset=args.patch_offset,
            feather=args.feather,
            fullart_mask_dilate=args.fullart_mask_dilate,
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
            threshold=args.threshold,
            sample_depth=args.sample_depth,
            inset_along_edge=args.inset_along_edge,
            corner_radius=args.corner_radius,
            corner_padding=args.corner_padding,
            ring_width=args.ring_width,
            patch_offset=args.patch_offset,
            feather=args.feather,
            fullart_mask_dilate=args.fullart_mask_dilate,
            dry_run=args.dry_run,
        )


if __name__ == "__main__":
    main()