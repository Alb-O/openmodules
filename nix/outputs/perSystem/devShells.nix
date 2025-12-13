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
      ...
    }:
    {
      default = pkgs.mkShell {
        packages = [
          pkgs.ast-grep
          pkgs.bun
          pkgs.nodejs
          inputs.bun2nix.packages.${pkgs.system}.default
          self'.formatter
        ];

        shellHook = ''
          if [ -t 0 ]; then
            bun install --frozen-lockfile
            (cd cli && bun install --frozen-lockfile)
          fi
        '';
      };
    };
}
