# Third-Party Notices

This file records third-party projects and licenses relevant to zTerm's public
source distribution.

The current public source tree is original zTerm code plus normal package
manager dependencies resolved through `package-lock.json` and
`src-tauri/Cargo.lock`. No third-party project source file has been copied into
the repository.

## Reference Projects

| Project | License / Permission | Current Use | Distribution Note |
| --- | --- | --- | --- |
| Kerminal | AGPL-3.0-only source license; project name, logo, icons, screenshots, and other brand assets are separately restricted | Technical architecture design reference only; no source files, UI assets, screenshots, icons, logos, or brand materials have been copied | Do not copy AGPL-covered source or restricted brand assets without separate license review and permission |
| NyaTerm | MIT License, Copyright (c) 2026 Kang | Architecture and configuration reference only | Keep the MIT notice if source is copied in the future |
| WindTerm | Public source distribution describes first-party code as Apache-2.0, excluding bundled third-party directories | UI information architecture reference only | Do not copy excluded third-party source without separate license review |

## Bundled Dependencies

zTerm depends on npm and Cargo packages. Their exact versions are locked in:

- `package-lock.json`
- `src-tauri/Cargo.lock`

Release artifacts are produced by GitHub Actions from the public source tree and
the locked dependency graph.
