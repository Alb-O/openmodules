{
  __inputs = {
    bun2nix.url = "github:baileyluTCD/bun2nix?tag=1.5.2";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "systems";
  };

  __functor =
    _:
    {
      pkgs,
      inputs,
      self',
      rootSrc,
      ...
    }:
    let
      bun2nixPkg = inputs.bun2nix.packages.${pkgs.system}.default;
    in
    {
      # Plugin bundle (minified JS)
      engrams-bundle = pkgs.callPackage (rootSrc + /nix) {
        bun2nix = bun2nixPkg;
        src = rootSrc;
        bunNix = rootSrc + /nix/bun.nix;
      };

      # CLI that depends on the bundled plugin
      engram = pkgs.callPackage (rootSrc + /cli/nix) {
        bun2nix = bun2nixPkg;
        src = rootSrc + /cli;
        bunNix = rootSrc + /cli/nix/bun.nix;
        pluginBundle = self'.packages.engrams-bundle;
      };

      # Default package should be the CLI, not the raw bundle
      default = self'.packages.engram;
    };
}
