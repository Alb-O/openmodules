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
    {
      default = pkgs.mkShell {
        packages = [
          pkgs.ast-grep
          pkgs.bun
          pkgs.nodejs
          pkgs.typescript
          pkgs.typescript-language-server
          inputs.bun2nix.packages.${pkgs.system}.default
          self'.formatter
        ];

        shellHook = ''
          if [ -t 0 ]; then
            bun install --frozen-lockfile

            # Install pre-commit hook
            if [ -d .git ]; then
              cp ${rootSrc}/nix/scripts/pre-commit .git/hooks/pre-commit
              chmod +x .git/hooks/pre-commit
            fi
          fi
        '';
      };
    };
}
