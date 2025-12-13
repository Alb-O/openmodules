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

  # Don't strip binaries - Bun compiled binaries embed their code in the executable
  dontStrip = true;

  # Don't use the default bun build (which expects --compile)
  dontUseBunBuild = true;

  # Custom build phase for both plugin bundle and CLI
  buildPhase = ''
    runHook preBuild

    # Build the minified plugin bundle
    bun build ./src/index.ts \
      --outfile ./dist/engrams.bundle.js \
      --target node \
      --minify \
      --external zod \
      --external @opencode-ai/plugin

    # Build the CLI as a standalone executable with embedded Bun runtime
    bun build ./src/cli/index.ts \
      --compile \
      --outfile ./dist/engram

    runHook postBuild
  '';

  # Don't use the default install phase (which expects a compiled binary)
  dontUseBunInstall = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/engrams
    cp dist/engrams.bundle.js $out/share/engrams/engrams.min.js
    cp dist/engram $out/bin/engram
    runHook postInstall
  '';
}
