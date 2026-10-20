VoxBridge site build
====================

`node build.js` writes the static site to `public/`. The pages, styles, fonts
and images are taken from the repository at the commit named in build.js, so
a build always matches a known commit. When a local checkout is present it is
used directly; otherwise the files are fetched over HTTPS.

Release binaries are mirrored into `public/downloads` at build time:

  VoxBridge-android.apk              <- the latest Android APK
  VoxBridge-ios.ipa                  <- the latest unsigned IPA
  VoxBridge-windows-setup.exe        <- the Windows installer
  VoxBridge-windows-portable.zip     <- the portable build
  manifest.json                      <- version, sizes and SHA-256
  SHA256SUMS.txt                     <- sha256sum-compatible list

Serving them from this origin is deliberate: the old links bounced through
GitHub's asset CDN, which stalls at 100% on some mobile carriers. The download
page reads manifest.json and falls back to the GitHub release automatically if
a file could not be mirrored. Set VOXBRIDGE_HOST_WINDOWS=0 to skip the two
large Windows files; set VOXBRIDGE_ASSETS_DIR=/path to build from local copies.
