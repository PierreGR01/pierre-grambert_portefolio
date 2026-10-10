# pierregrambert.fr — Portfolio

Source code for [pierregrambert.fr](https://pierregrambert.fr), hosted on GitHub Pages.

## Structure

```
/
├── index.html              # Homepage
├── my-resume.html          # Resume
├── bivouac/                # Case study — Bivouac (outdoor safety app)
├── kairn/                  # Case study — Kairn Design Studio (embedded UI)
├── saprea/                 # Case study — Saprea (non-profit digital platform)
├── georchestra/            # Case study — geOrchestra (open-source geospatial SDI)
├── mercator-ocean/         # Case study — Mercator Ocean (five Copernicus Marine applications)
├── assets/                 # Images, fonts, shared resources
├── 404.html                # Served by GitHub Pages for any missing address
├── sitemap.xml
└── robots.txt
```

## Redirects from the former WordPress site

Until 2026 the domain served a WordPress site under `www.`. GitHub Pages cannot send server redirects, so each old address that has a current equivalent keeps a small `index.html` with an instant meta refresh (read by Google as a permanent redirect) and a canonical link to the new page:

| Old address | Now |
| --- | --- |
| `/kairn-design-studio/` | `/kairn/` |
| `/saprea-2/`, `/saprea-support-groups/`, `/saprea-operations-resources/` | `/saprea/` |
| `/my-resume/` | `/my-resume.html` |

Old pages without an equivalent (`/petzl/`, `/brgm/`, `/my-skills/…`) land on `404.html`, which lists every page of the site. Redirect folders stay out of `sitemap.xml`.

## Stack

Plain HTML/CSS — no build step, no framework. Deployed directly via GitHub Pages with a custom domain (`CNAME`).

Visual identity: animated WebGL blobs, electric blue `rgb(130, 225, 255)`, Inter & Titillium Web, glassmorphism headers.

## About

Pierre Grambert — UX/Product Designer specializing in geospatial data interfaces, open-source ecosystems, and design systems for public institutions. Based in Grenoble, France.

[pierregrambert.fr](https://pierregrambert.fr) · [LinkedIn](https://www.linkedin.com/in/pierregrambert/) · [Malt](https://www.malt.fr/profile/pierregrambert)
