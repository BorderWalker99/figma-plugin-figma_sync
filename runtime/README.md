# Offline Runtime Layout

This folder is used by the installer "fat package" flow.

Required structure:

- `runtime/intel/bin/`
- `runtime/apple/bin/`

Each `bin` directory must contain:

- `node`
- `ffmpeg`
- `ffprobe`
- `gifsicle`
- `magick` (or `convert`)

Optional but recommended:

- `npm`
- `npx`

You can use `prepare-offline-runtime.sh` in the project root to populate these folders from your local machine.

# Offline Runtime Layout

This folder stores architecture-specific offline runtimes for installer fat packages.

Expected structure:

- `runtime/intel/bin/`
- `runtime/apple/bin/`

Each `bin` directory must contain:

- `node`
- `ffmpeg`
- `ffprobe`
- `gifsicle`
- `magick` (or `convert`)

Optional but recommended:

- `npm`
- `npx`

The installer and release scripts will validate these files before packaging.
# Offline Runtime Layout

Place architecture-specific offline runtime files here before running `./release.sh`.

- Intel package source: `runtime/intel/`
- Apple Silicon package source: `runtime/apple/`

Each architecture folder must contain:

- `bin/node`
- `bin/ffmpeg`
- `bin/ffprobe`
- `bin/gifsicle`
- `bin/magick` (or `bin/convert`)

`package-for-distribution.sh` will fail if required binaries are missing.
