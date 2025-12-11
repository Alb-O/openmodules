# Affinity Extractor

Extract layer names, text content, fonts, and element bounding boxes from Affinity v3 files.

## Quick Start

Run the extraction script:

`python extract_affinity.py document.af output.json`

For pre-extracted ZSTD data:

`python extract_affinity.py --from-bin extracted.bin output.json`

## Output Format

The script outputs JSON with these fields:

```json
{
  "source": "document.af",
  "metadata": {"document": {...}},
  "layers": ["Layer 1", "Button", "Slider"],
  "text_content": ["Label", "Value"],
  "fonts": ["Roboto-Regular", "ArialMT"],
  "element_sizes": [{"width": 1920, "height": 1080, "x": 0, "y": 0}]
}
```

## Workflow

1. Run extraction script on the `.af` file to get structured JSON
2. Analyze output for layer hierarchy, text labels, fonts used
3. Use `element_sizes` to understand layout dimensions (sorted by area, largest first)

Extracted assets can be placed in `tmp/` in current workspace for easy access (should be gitignore'd).

## Extracting Embedded Images

To extract embedded images from Affinity files, use `binwalk` directly:

`binwalk --extract document.af`

This will create a `_document.af.extracted/` directory containing ZSTD compressed document data and any embedded images with their dimensions.

Images are extracted to subdirectories named by their hex offset (e.g. `670D1/image.png`).

### Viewing Extracted Images

After extraction, use the `read` tool with the absolute file path to view images inline and analyze, returning a comprehensive description without needing external image viewers/OCR.

## Requirements

- Python 3.10+
- `binwalk` (via system install or `nix-shell -p binwalk`)

The script auto-detects `binwalk` and falls back to `nix-shell` if unavailable.

## Limitations

- Cannot extract vector paths or effects
- Cannot render artboards (they exist only as vector data)
- Bounding boxes are approximate
- Some localization strings are filtered out
