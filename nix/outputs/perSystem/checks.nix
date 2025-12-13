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

      bun2nix = inputs.bun2nix.packages.${pkgs.system}.default;
      bunNix = rootSrc + "/nix/bun.nix";
    in
    {
      formatting = formatterEval.config.build.check self;

      ast-grep-test = pkgs.runCommand "ast-grep-test" { } ''
        cd ${rootSrc}
        ${pkgs.ast-grep}/bin/ast-grep test --skip-snapshot-tests
        touch $out
      '';

      ast-grep-scan = pkgs.runCommand "ast-grep-scan" { } ''
        cd ${rootSrc}
        ${pkgs.ast-grep}/bin/ast-grep scan
        touch $out
      '';

      typescript = bun2nix.mkDerivation {
        pname = "typescript-check";
        version = "0.0.0";
        src = rootSrc;
        bunDeps = bun2nix.fetchBunDeps { inherit bunNix; };

        nativeBuildInputs = [ pkgs.typescript ];

        dontUseBunBuild = true;
        dontUseBunInstall = true;

        buildPhase = ''
          runHook preBuild
          tsc --noEmit
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          touch $out
          runHook postInstall
        '';
      };
    };
}
