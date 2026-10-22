# paseo-cachebeat-pill

A [Paseo](https://paseo.sh) plugin that shows the prompt-cache state of Claude agents as a composer pill, with a card for turning [cachebeat](https://github.com/404Mayank/cachebeat) on or off, beating now and setting its interval.

See [OVERVIEW.md](OVERVIEW.md) for what it shows and its limits.

## Install

```sh
git clone https://github.com/onggiabayluon/paseo-cachebeat-pill
cd paseo-cachebeat-pill && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.11.1 or later. After editing the source, run `npm run typecheck` and `paseo plugin reload cachebeat-pill`.
