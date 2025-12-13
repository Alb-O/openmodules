/**
  TypeScript/JavaScript formatting configuration using Prettier.

  Provides Prettier-based formatting for TypeScript, JavaScript, JSON,
  and related web files.
*/
{ pkgs, lib }:
{
  /**
    Prettier package from nixpkgs.

    Uses the nodePackages.prettier from the provided pkgs.
  */
  package = pkgs.nodePackages.prettier;

  /**
    Generate treefmt settings for Prettier.

    # Arguments

    prettierPkg
    : The prettier package.

    # Returns

    Attrset with treefmt formatter configuration for Prettier.
    Formats TypeScript, JavaScript, JSON, CSS, and Markdown files.
  */
  settings = prettierPkg: {
    prettier = {
      command = lib.getExe prettierPkg;
      options = [ "--write" ];
      includes = [
        "*.ts"
        "*.tsx"
        "*.js"
        "*.jsx"
        "*.mjs"
        "*.cjs"
        "*.json"
        "*.css"
        "*.scss"
        "*.md"
        "*.yaml"
        "*.yml"
      ];
    };
  };
}
