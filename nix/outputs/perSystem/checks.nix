{
  pkgs,
  self,
  treefmt-nix,
  imp-fmt-lib,
  rootSrc,
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

  ast-grep = pkgs.runCommand "ast-grep-check" { } ''
    cd ${rootSrc}
    ${pkgs.ast-grep}/bin/ast-grep test --skip-snapshot-tests
    touch $out
  '';
}
