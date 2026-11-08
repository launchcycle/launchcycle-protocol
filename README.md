# CYCLE

A loop that pays itself back.

[![Live site](https://img.shields.io/badge/live-launchcycle.fun-21d0f7?style=flat-square)](https://launchcycle.fun)

| | |
|---|---|
| Chain | Solana |
| Contract | pending |

## Overview

CYCLE is a Solana token built around a closed circuit: what the project earns is routed back toward the token it belongs to, then the circuit starts another lap. This repository holds the site served at launchcycle.fun.

## Features

- Live market board of the most active Solana tokens, refreshed every minute and paused while the tab is hidden.
- Row one of the board is reserved for CYCLE itself. It shows a brand placeholder until a contract is stated, then switches to live data for that contract.
- A register that holds every outside fact as one record. Records that are not yet stated render inert.
- Contract slot pinned to the top of the page with click to copy.
- Motion that respects the reduced-motion setting.

## Links

- Site: https://launchcycle.fun
- X: pending
- GitHub: pending
- Whitepaper: [docs/whitepaper.md](docs/whitepaper.md)

## Build

```bash
npm install
npm run build
npm run gates
```

The deployable output is `dist/`.

## License

MIT. See [LICENSE](LICENSE).
