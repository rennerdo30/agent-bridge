---
title: Documentation conventions
---

The documentation project lives in `docs/`, with its own private ESM package, Astro configuration, Starlight content collection and `dev`, `build`, and `preview` scripts. It follows the layouts in WinMux, Bifrost Proxy and the WoW Toolkit.

## Versions and theme

The npm stable tags checked on 2026-10-08 select Astro **7.3.6**, Starlight **0.42.5** and Galaxy **1.0.0**. The lockfile fixes the installed versions. WinMux and Bifrost Proxy declare Astro `^5.18.0`, Starlight `^0.37.6` and Galaxy `^0.7.0`; their files do not document a reason to keep those older versions. The Toolkit already declares Astro `^7.3.3` and Starlight `^0.42.2`. This site uses current Galaxy, retaining the grouped explicit sidebar convention and adding the bridge's blue accent through custom CSS.

See the [Astro releases](https://github.com/withastro/astro/releases) and [Starlight configuration reference](https://starlight.astro.build/reference/configuration/).

## Branding, links and deployment

The existing repository SVG is copied into `src/assets/` for Starlight's logo and into `public/favicon.svg` for the default favicon path. Assets are copied before development and builds, following the Toolkit's prebuild synchronization pattern. Screenshots stay canonical in `docs/images/`, so README links keep working, and the site copies them into `public/images/`.

`actions/configure-pages` supplies the origin and base path to the Astro CLI. Local builds default to `https://rennerdo30.github.io/agent-bridge/`. The workflow uses `ubuntu-latest`, matching Bifrost Proxy: this repository exposes no self-hosted docs runners. npm caching, Pages artifact upload and the deployment environment match all three projects. The site uses Node 22, which supports current Astro.

Edit links point at `main/docs/`; Starlight appends the full content source path. Existing root `docs/*.md` URLs remain as small pointers to the migrated canonical pages, preserving repository links without maintaining duplicate content.

## Local checks

```sh
cd docs
npm ci
npm run build
npm run check:built -- /agent-bridge/
```

The MCP reference is regenerated from `src/mcp/server.ts` and target schemas before every build. Changes to those source files also trigger the Pages workflow. No product installation or update is needed to build the documentation.
