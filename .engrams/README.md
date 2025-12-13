# Example Modules

This directory contains example modules to demonstrate the plugin structure.

Each module directory must contain an `engram.toml` manifest. The prompt content defaults to `README.md` at the module root, but can be configured via the `prompt` field in the manifest.

## Structure

```
modules/
└── example/
    ├── engram.toml       # Required: module manifest
    ├── README.md             # Default: agent instructions (configurable)
    ├── .ignore               # Optional: file filtering
    ├── hello.sh              # Scripts with oneliner markers
    └── process.py
```
