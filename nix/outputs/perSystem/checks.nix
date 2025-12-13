{
  pkgs,
  self,
  treefmt-nix,
  imp-fmt-lib,
  ...
}:
let
  formatterEval = imp-fmt-lib.makeEval {
    inherit pkgs treefmt-nix;
    excludes = [
      "node_modules/*"
      "**/node_modules/*"
      "bun.lock"
      "**/bun.lock"
      ".engrams/*"
    ];
  };
in
{
  formatting = formatterEval.config.build.check self;
}
