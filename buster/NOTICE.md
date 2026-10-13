# Embedded Buster

Derived from dessant/buster 3.4.0, commit 4f6fa9f26321fd645401e2f96e00cea4f8532e1a.
Copyright (c) 2018-2026 Armin Sebastian. GPL-3.0-only; see the root LICENSE.

Vodka modifications: Arena-only trusted manual UI and default-off local automatic once; per-document session claims; private storage namespace; host-safe messages and setup; local Whisper preparation; custom settings; no managed-cloud secrets or native client.
Corresponding adapted upstream source is in vendor/buster/upstream. Recipe and adapter source are in tools/integrate-buster.mjs; npm package versions are pinned in the preserved upstream package-lock.json. Existing ModelTrace MIT notices and license remain unchanged.

Build: clone the pinned commit, npm ci, run the recipe prepare phase, ENABLE_CONTRIBUTIONS=false ENABLE_SPONSORS=false npm run build:prod:chrome, then run recipe import. Requires the upstream-supported Node toolchain. No captcha success or browser runtime testing is asserted.
