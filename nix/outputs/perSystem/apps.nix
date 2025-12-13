{
  self',
  ...
}:
{
  engram = {
    type = "app";
    program = "${self'.packages.engram}/bin/engram";
    meta.description = "CLI for managing engrams";
  };
}
