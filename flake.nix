{
  description = "OpenCode Skills Plugin";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    systems.url = "github:nix-systems/default";

    bun2nix.url = "github:baileyluTCD/bun2nix?tag=1.5.2";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "systems";
  };

  nixConfig = {
    extra-substituters = [
      "https://cache.nixos.org"
      "https://cache.garnix.io"
    ];
    extra-trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      "cache.garnix.io:CTFPyKSLcx5RMJKfLo5EEPUObbA78b0YQ2DTCJXqr9g="
    ];
  };

  outputs =
    {
      nixpkgs,
      systems,
      bun2nix,
      ...
    }:
    let
      eachSystem = nixpkgs.lib.genAttrs (import systems);
      pkgsFor = eachSystem (system: import nixpkgs { inherit system; });
    in
    {
      packages = eachSystem (system: {
        default = pkgsFor.${system}.callPackage ./nix {
          inherit (bun2nix.lib.${system}) mkBunDerivation;
          src = ./.;
          bunNix = ./nix/bun.nix;
        };
      });

      devShells = eachSystem (system: {
        default = pkgsFor.${system}.mkShell {
          packages = with pkgsFor.${system}; [
            bun
            nodejs
            bun2nix.packages.${system}.default
          ];

          shellHook = ''
            if [ -t 0 ]; then
              bun install --frozen-lockfile
            fi
          '';
        };
      });
    };
}
