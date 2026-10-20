VoxBridge site build
====================

`node build.js` writes the static site to `public/`. The pages, styles, fonts
and images are taken from the repository at the commit named in build.js, so
the deployment payload stays small and a build always matches a known commit.
