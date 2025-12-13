{
  bun2nix,
  bunNix,
  src,
  ...
}:

bun2nix.mkDerivation {
  pname = "engrams";
  version = "1.0.0";
  src = src;
  bunDeps = bun2nix.fetchBunDeps {
    inherit bunNix;
  };
  bunBuildFlags = [
    "./src/index.ts"
    "--outfile"
    "./dist/engrams.bundle.js"
    "--target"
    "node"
    "--minify"
    "--external"
    "zod"
    "--external"
    "@opencode-ai/plugin"
  ];
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp dist/engrams.bundle.js $out/engrams.min.js
    runHook postInstall
  '';
}
