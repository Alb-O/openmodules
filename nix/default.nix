{
  mkBunDerivation,
  bunNix,
  src,
  ...
}:

mkBunDerivation {
  pname = "openmodules";
  version = "1.0.0";
  src = src;
  bunNix = bunNix;
}
