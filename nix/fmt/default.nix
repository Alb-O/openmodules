/**
  Formatter configuration for OpenModules.

  Provides treefmt-nix configuration with Prettier for TypeScript/JavaScript
  and nixfmt for Nix files.

  # Example

  ```nix
  {
    formatter = eachSystem (system:
      fmtLib.make { pkgs = pkgsFor.${system}; }
    );

    checks = eachSystem (system: {
      formatting = fmtLib.check {
        pkgs = pkgsFor.${system};
        self = self;
      };
    });
  }
  ```
*/
{ treefmt-nix }:
let
  # Default parameter values
  defaultParams = {
    excludes = [
      "node_modules/*"
      "**/node_modules/*"
      "bun.lock"
      "**/bun.lock"
      ".openmodules/*"
    ];
    extraFormatters = { };
    nixfmt = {
      enable = true;
    };
    prettier = {
      enable = true;
    };
    projectRootFile = "flake.nix";
  };

  # Extract formatter params (filtering out pkgs)
  extractParams =
    {
      excludes ? defaultParams.excludes,
      extraFormatters ? defaultParams.extraFormatters,
      nixfmt ? defaultParams.nixfmt,
      prettier ? defaultParams.prettier,
      projectRootFile ? defaultParams.projectRootFile,
      ...
    }:
    {
      inherit
        excludes
        extraFormatters
        nixfmt
        prettier
        projectRootFile
        ;
    };
in
{
  /**
    Create a formatter derivation for use in flake outputs.

    Returns a treefmt wrapper suitable for `formatter.<system>`.

    # Arguments

    pkgs
    : Nixpkgs instance.

    excludes
    : (optional) List of glob patterns to exclude from formatting.
      Default excludes node_modules, bun.lock, and .openmodules directories.

    extraFormatters
    : (optional) Additional treefmt formatter settings (merged with defaults). Default: `{}`.

    nixfmt
    : (optional) Attrset with `enable` boolean for nixfmt. Default: `{ enable = true; }`.

    prettier
    : (optional) Attrset with `enable` boolean for Prettier. Default: `{ enable = true; }`.

    projectRootFile
    : (optional) File that marks the project root for treefmt. Default: `"flake.nix"`.

    # Example

    ```nix
    formatter = fmtLib.make {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      excludes = [ "generated/*" ];
    };
    ```
  */
  make =
    args@{ pkgs, ... }:
    let
      lib = pkgs.lib;
      libFuncs = import ./lib.nix { inherit pkgs lib; };
      params = extractParams args;
      treefmtConfig = libFuncs.buildTreefmtConfig params;
      treefmtEval = treefmt-nix.lib.evalModule pkgs treefmtConfig;
    in
    treefmtEval.config.build.wrapper;

  /**
    Create a formatting check for use in flake checks.

    Returns a check derivation that fails if formatting is incorrect.

    # Arguments

    pkgs
    : Nixpkgs instance.

    self
    : The flake's self reference (needed for checking against source).

    # Example

    ```nix
    checks.formatting = fmtLib.check {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      self = self;
    };
    ```
  */
  check =
    args@{ pkgs, self, ... }:
    let
      lib = pkgs.lib;
      libFuncs = import ./lib.nix { inherit pkgs lib; };
      params = extractParams args;
      treefmtConfig = libFuncs.buildTreefmtConfig params;
      treefmtEval = treefmt-nix.lib.evalModule pkgs treefmtConfig;
    in
    treefmtEval.config.build.check self;
}
