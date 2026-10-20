# Contributing

Thanks for helping! Issues and pull requests are welcome in English, Spanish or Portuguese.

## Setup

```sh
npm install
npm run dev
```

Before opening a pull request:

```sh
npm run lint && npm run typecheck && npm test
```

## Architecture

- **`src/core`** holds all PS4 logic in plain Node, with no Electron imports, so it can be tested and reused (for example by a future headless or Android version). `AppCore` ties the services together and is the only thing the Electron layer talks to.
- **`src/main`** is the Electron main process. It owns the window, native dialogs and tray, and exposes `AppCore` through IPC (`src/main/ipc.ts`).
- **`src/preload`** exposes the typed `Api` (`src/shared/types.ts`) as `window.api`. The renderer has no Node access (`contextIsolation`, `sandbox`).
- **`src/renderer`** is the interface, in TypeScript without a framework. Each screen is a module in `src/renderer/src/views`.
- **Errors** are `AppError(code, params)` in the core. The interface shows `errors.<code>` from the locale files, so no user-facing text lives in the core.

## Adding a language

1. Copy `src/shared/locales/en.json` to `src/shared/locales/<tag>.json` and translate the values. Keep every `{placeholder}`.
2. Add the tag to `LANGUAGES` in `src/shared/types.ts`, and its name to `LANGUAGE_NAMES` and `MESSAGES` in `src/shared/i18n.ts`. Map system locales to it in `matchLanguage`.
3. Optional: add its param.sfo title keys to `TITLE_KEYS` in `src/core/pkg/PkgReader.ts`, so games show their localized names.
4. `npm test` checks that every language has the same keys and placeholders.

## Payloads

The PS4 payloads are built from source by `payloads/build.sh`. See `payloads/README.md`. A wrong payload can crash the console, so test changes on real hardware and describe the firmware and GoldHEN version you used.

## Commits

Small, focused commits with a clear message. Reference the issue when there is one.
