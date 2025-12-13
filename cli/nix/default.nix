{
  bun2nix,
  bunNix,
  src,
  pluginBundle,
  ...
}:

bun2nix.mkDerivation {
  pname = "engram";
  version = "0.1.0";
  src = src;
  bunDeps = bun2nix.fetchBunDeps {
    inherit bunNix;
  };
  module = "src/index.ts";

  # Make plugin bundle available at runtime
  postInstall = ''
    mkdir -p $out/share/engrams
    cp ${pluginBundle}/engrams.min.js $out/share/engrams/
  '';
}
