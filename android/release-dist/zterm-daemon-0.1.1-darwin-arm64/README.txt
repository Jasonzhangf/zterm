ZTerm daemon standalone release
version: 0.1.1
target: darwin-arm64

Install:
  ./bin/install-global.sh

Then:
  zterm-daemon install-service
  zterm-daemon service-status
