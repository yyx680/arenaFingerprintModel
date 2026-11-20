# Third-party notices

## ModelTrace

The fingerprint scoring core, challenge wording, bundled fallback bank, and regression fixture are derived from:

- Project: ModelTrace
- Author: xqy2006
- Source: https://github.com/xqy2006/ModelTrace
- Revision: `d4131b30243dfa05e70180b5eedde742103f1d73`
- License: MIT — see `LICENSE-ModelTrace`

Included files:

- `modeltrace-core.js`
- `modeltrace-bank.json`
- `tests/fixtures/gpt-6-astra-three.json`

## Fingerpoint Detector (lmfpd)

The primary numeric fingerprint engine and bundled reference data are derived from:

- Project: lm-detector / lmfpd-sdk
- Author: xqy2006 (Ikaleio)
- Source: https://github.com/Ikaleio/lm-detector , https://lm.ikale.io
- License: MIT — see `LICENSE-LMFPD`

Included files:

- `lmfpd-channel.js` (ported scoring core: shared-detector-v2 ranker, sequence-shape gate including `nearby_pair_share`, calibrated ranking, online refresh & IndexedDB caching)
- `lmfpd-data/unified_bank.json` and `lmfpd-data/shared_detector.bin` (75-model reference bank snapshot built 2026-11-19, refreshed by `tools/fetch-lmfpd-data.mjs` or in-extension online refresh)

All replies are scored locally; no reply text or numeric sequences are sent to lm.ikale.io or any third party.

## fzstd

Pure JS Zstandard decompressor used for in-extension online refresh of `shared_detector.bin.*.zst` chunks:

- Project: fzstd (`0.1.1`)
- Author: Arjun Barrett
- Source: https://github.com/101arrowz/fzstd
- License: MIT — see `LICENSE-fzstd`

Included files:

- `fzstd.js`

## WhatsMyLLM methodology (runtime bank request removed in 2.19.13)

The input normalization and prompt wording originally followed the public methodology at https://whatsmyllm.com/methodology/. Runtime network requests to `https://whatsmyllm.com/data/bank/v2026.09.5.json` were removed in 2.19.13 in favor of `lm.ikale.io`.

## Embedded Buster

- Upstream: https://github.com/dessant/buster
- Version: 3.4.0; pinned commit `4f6fa9f26321fd645401e2f96e00cea4f8532e1a`
- Copyright (c) 2018–2026 Armin Sebastian
- License: GPL-3.0-only. The combined extension is distributed under GPL-3.0-only; see `LICENSE`.
- Runtime and dependency notices: `buster/NOTICE.md`, `buster/licenses/`, and emitted `*.LICENSE.txt` files.
- Adapted corresponding upstream source: `vendor/buster/upstream`; reproducible adapter: `tools/integrate-buster.mjs`.
- Modifications restrict the UI to Arena-hosted reCAPTCHA frames, isolate storage and message routing, require explicit local Whisper preparation, offer a default-off visible-frame single local automatic attempt with session claims, provide optional owner-supplied ASR keys for manual use, and omit native-client/managed-cloud secrets, donation prompts and action takeover.
- Model weights are not bundled. Local preparation downloads Whisper Tiny model files from Hugging Face only after an explicit user action. Optional cloud providers receive challenge audio only when selected by the user.

## Arena Trace Inspector（额度端点语义）

每日额度读取的端点与字段语义（`GET https://arena.ai/api/me/pulse` → `{pulse, refreshedAt}`，`pulse` 为剩余百分比）参考自本机安装的 Arena Trace Inspector 2.3.2 的 `billing.js`（该副本由「沐介之9.20改」维护）。本扩展只移植纯解析逻辑与错误处理约定，未复制该项目的 trace 读取、debugger、cookies 或 declarativeNetRequest 组件。
