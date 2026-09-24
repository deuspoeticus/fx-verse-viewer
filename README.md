# FX(VERSE) — self-hosted

Everything comes from Ethereum. No fxhash servers are used.

## Setup (once)

    npm install
    npm run archive

`archive` reads the generator bundle from the onchfs FileSystem contract
(`0x9e0f…2e04`) into `generator/`, and each token's seed, minter and
fxParams via `genArtInfo(id)` into `tokens.json`.

## Run

    npm run serve        # then open http://localhost:8000

Must be served over http (not opened as a file).

## Deploy

Upload the folder as-is (`index.html`, `generator/`, `fonts/`, `tokens.json`)
to any static host. `node_modules/`, `package*.json`, `archive.mjs` aren't
needed there.

The page reads tokens live from public Ethereum RPCs and falls back to
`tokens.json` if they're unreachable. Re-run `npm run archive` after new
mints to refresh the snapshot.
