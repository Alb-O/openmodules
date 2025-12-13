{
  self',
  ...
}:
{
  engram = {
    type = "app";
    program = "${self'.packages.engram}/bin/engram";
  };
}
