{
  mkBunDerivation,
  bunNix,
  src,
  ...
}:

mkBunDerivation {
  pname = "openskills";
  version = "1.0.0";
  src = src;
  bunNix = bunNix;
}
