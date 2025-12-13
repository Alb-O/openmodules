/**
  Core library functions for formatter configuration.

  Internal module used by `make` and `check` to construct treefmt
  configurations from user-provided parameters.
*/
{
  pkgs,
  lib,
}:
let
  prettierLib = import ./formatters/prettier.nix { inherit pkgs lib; };
in
{
  /**
    Build the treefmt configuration attrset.

    This is the shared logic used by both `make` and `check` functions.
    Constructs the final treefmt configuration by combining formatter-specific
    settings based on enabled features.

    # Arguments

    excludes
    : Glob patterns to exclude from formatting.

    extraFormatters
    : Additional treefmt formatter settings.

    nixfmt
    : Attrset with `enable` boolean for nixfmt.

    prettier
    : Attrset with `enable` boolean for Prettier.

    projectRootFile
    : File that marks the project root.
  */
  buildTreefmtConfig =
    {
      excludes,
      extraFormatters,
      nixfmt,
      prettier,
      projectRootFile,
    }:
    let
      prettierPkg = prettierLib.package;
      prettierSettings = if prettier.enable then prettierLib.settings prettierPkg else { };
    in
    {
      inherit projectRootFile;
      programs.nixfmt.enable = nixfmt.enable;
      settings.global.excludes = excludes;
      settings.formatter = prettierSettings // extraFormatters;
    };
}
