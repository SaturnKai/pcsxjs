# PCSXJS (Fork)

A fork of [tjwei/pcsxjs](https://github.com/tjwei/pcsxjs), a PCSX emulator compiled to WebAssembly. The original repository has been modified to support compiling on modern Emscripten versions:

- Added `pcsx.js`, a modular wrapper for the compiled emulator
- Added exports and additional flags to `Makefile`
- Fixed globals in `gui/Config.c` and `gui/Linux.h`
- Fixed file system and added `loadbuffer` command to `worker_funcs.js`
