---
oneliner: "reference for manual extraction or debugging"
---

# Affinity Designer File Format Reference

Affinity Designer v2/v3 files (`.afdesign`, `.af`) use an undocumented binary format.

## Structure

Header magic bytes `00 FF 4B 41` ("KA"), followed by section markers (`nsrP`, `#Inf`, `Prot`, `#Fil`). Document data is ZSTD-compressed at offset ~0x4C; raster assets sit uncompressed at higher offsets.

## Tag Reference

Reversed 4-character tags identify structural elements:

| Tag     | Meaning          | Data Format                               |
| ------- | ---------------- | ----------------------------------------- |
| `1CgaT` | Layer/group name | Name string precedes the tag              |
| `+ymaF` | Font family      | Font name precedes the tag                |
| `+8ftU` | UTF-8 text       | Followed by 4-byte LE length, then string |
| `BphS`  | Shape bounds     | Followed by 4 doubles: x1, y1, x2, y2     |
| `drGB`  | RGB color data   |                                           |
| `HsdG`  | Gradient stops   |                                           |
| `NphS`  | Shape node       |                                           |
| `dlhC`  | Child node       |                                           |

## Extractable Data

- Document metadata (artboard count, title, version) as embedded JSON
- Layer/group names and hierarchy
- Text content (labels, values)
- Font family references
- Element bounding boxes (positions/sizes as 4 doubles)
- Linked/placed raster images, document thumbnail

**Not extractable:** vector paths, rendered artboards, effects, precise styling.

## Manual Extraction Commands

```sh
# Find JSON metadata
strings -n 15 document.af | head

# Identify embedded data offsets
binwalk document.af

# Extract ZSTD and PNG data to subdirectory
binwalk --extract document.af

# Search extracted ZSTD for layer names
strings -n 8 */zstd_* | grep -iE 'slider|button|layer'

# Find fonts
strings */zstd_* | grep '+ymaF' | sort -u
```

## Text String Format

Pattern: `+8ftU` + 4-byte little-endian length + UTF-8 content.

## Bounds Format

4 IEEE 754 doubles (32 bytes total) representing x1, y1, x2, y2 in document coordinates.
