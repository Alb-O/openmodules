#!/usr/bin/env python3

# oneliner: Main extraction script; run directly on `.af` files

"""
Extract design assets from Affinity Designer files.

Usage:
    python extract-affinity.py <document.af> [output.json]
    python extract-affinity.py --from-bin <extracted.bin> [output.json]

Extracts layer names, text content, fonts, and element sizes from
the ZSTD-compressed document data within an Affinity Designer file.

Requires binwalk (available via nix-shell -p binwalk).
"""

import struct
import json
import sys
import subprocess
import tempfile
import os
from pathlib import Path


def find_all(data: bytes, pattern: bytes) -> list[int]:
    """Find all occurrences of pattern in data."""
    positions = []
    pos = 0
    while True:
        pos = data.find(pattern, pos)
        if pos == -1:
            break
        positions.append(pos)
        pos += 1
    return positions


def extract_layers(data: bytes) -> list[str]:
    """Extract layer/group names (before 1CgaT markers)."""
    marker = b'1CgaT'
    positions = find_all(data, marker)
    names = set()
    
    for pos in positions:
        start = pos - 1
        while start > 0 and (data[start:start+1].isalnum() or data[start:start+1] in [b'_', b' ', b'-', b'.']):
            start -= 1
        name = data[start+1:pos].decode('ascii', errors='ignore').strip()
        if name and len(name) > 1:
            names.add(name)
    
    return sorted(names)


def extract_text(data: bytes) -> list[str]:
    """Extract text content (after +8ftU markers)."""
    marker = b'+8ftU'
    positions = find_all(data, marker)
    texts = set()
    
    for pos in positions:
        try:
            length = struct.unpack('<I', data[pos+5:pos+9])[0]
            if 0 < length < 500:
                text = data[pos+9:pos+9+length].decode('utf-8', errors='ignore').rstrip('\x00')
                if text and len(text.strip()) > 0:
                    # Filter out localization strings and keep design content
                    if not any(x in text.lower() for x in ['siehe', 'voir', 'vedi', 'consultar', 'ver ', 'endnotes']):
                        texts.add(text.strip())
        except:
            pass
    
    return sorted(texts)


def extract_fonts(data: bytes) -> list[str]:
    """Extract font family names (before +ymaF markers)."""
    marker = b'+ymaF'
    positions = find_all(data, marker)
    fonts = set()
    
    for pos in positions:
        start = pos - 1
        while start > 0 and (chr(data[start]).isalnum() or chr(data[start]) in '-_'):
            start -= 1
        font = data[start+1:pos].decode('ascii', errors='ignore')
        if font:
            fonts.add(font)
    
    return sorted(fonts)


def extract_bounds(data: bytes) -> list[dict]:
    """Extract element bounding boxes (after BphS markers)."""
    marker = b'BphS'
    positions = find_all(data, marker)
    bounds = []
    seen = set()
    
    for pos in positions:
        try:
            vals = struct.unpack('<4d', data[pos+4:pos+36])
            x1, y1, x2, y2 = vals
            w = round(x2 - x1)
            h = round(y2 - y1)
            if 0 < w < 10000 and 0 < h < 10000:
                key = (w, h, round(x1), round(y1))
                if key not in seen:
                    seen.add(key)
                    bounds.append({
                        "width": w,
                        "height": h,
                        "x": round(x1),
                        "y": round(y1)
                    })
        except:
            pass
    
    return sorted(bounds, key=lambda b: b["width"] * b["height"], reverse=True)


def extract_metadata(af_path: Path) -> dict | None:
    """Extract JSON metadata from raw file."""
    with open(af_path, 'rb') as f:
        raw = f.read()
    
    # Look for JSON metadata
    start = raw.find(b'{"document"')
    if start != -1:
        end = raw.find(b'}}', start) + 2
        try:
            return json.loads(raw[start:end])
        except:
            pass
    return None


def extract_zstd_data(af_path: Path) -> bytes | None:
    """Extract and decompress ZSTD data using binwalk (via nix-shell if needed)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Try binwalk directly, fall back to nix-shell
        binwalk_cmd = ['binwalk', '--extract', '--directory', tmpdir, str(af_path)]
        nix_cmd = ['nix-shell', '-p', 'binwalk', '--run', 
                   f"binwalk --extract --directory {tmpdir} '{af_path}'"]
        
        try:
            result = subprocess.run(binwalk_cmd, capture_output=True)
        except FileNotFoundError:
            result = subprocess.run(nix_cmd, capture_output=True, shell=False)
        
        # Find extracted zstd file
        for root, dirs, files in os.walk(tmpdir):
            for f in files:
                if 'zstd' in f.lower() or f.startswith('4C'):
                    fpath = Path(root) / f
                    with open(fpath, 'rb') as file:
                        return file.read()
    
    return None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    
    # Handle --from-bin flag for pre-extracted data
    if sys.argv[1] == '--from-bin':
        if len(sys.argv) < 3:
            print("Error: --from-bin requires a path to extracted binary data")
            sys.exit(1)
        bin_path = Path(sys.argv[2])
        output_path = Path(sys.argv[3]) if len(sys.argv) > 3 else None
        
        with open(bin_path, 'rb') as f:
            data = f.read()
        metadata = None
        source = str(bin_path)
    else:
        af_path = Path(sys.argv[1])
        output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
        
        if not af_path.exists():
            print(f"Error: {af_path} not found")
            sys.exit(1)
        
        metadata = extract_metadata(af_path)
        print(f"Extracting from {af_path}...", file=sys.stderr)
        data = extract_zstd_data(af_path)
        source = str(af_path)
        
        if not data:
            print("Error: Could not extract ZSTD data. Is binwalk installed?", file=sys.stderr)
            sys.exit(1)
    
    # Parse document structure
    result = {
        "source": source,
        "metadata": metadata,
        "layers": extract_layers(data),
        "text_content": extract_text(data),
        "fonts": extract_fonts(data),
        "element_sizes": extract_bounds(data)[:30]
    }
    
    output = json.dumps(result, indent=2)
    
    if output_path:
        with open(output_path, 'w') as f:
            f.write(output)
        print(f"Written to {output_path}", file=sys.stderr)
    else:
        print(output)


if __name__ == '__main__':
    main()
