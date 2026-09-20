# Personal Website

This is my personal website. Blown up and rebuilt September 2019, redesigned September 2026.

## Design

Swiss-poster layout inspired by [cristianrus.me](https://www.cristianrus.me): a solid "paper"
colour with cream "ink", a printed-paper grain, a numbered three-column nav, a large wordmark
pinned to the bottom of the screen, a rotated tagline, and a near-black dark mode.

Each page sets its own two colours inline on `<html>`:

```html
<html lang="en" style="--paper:#25457A; --ink:#F2EAD8">
```

Everything in `assets/css/styles.css` reads those two variables. Type is
[Geist](https://vercel.com/font) via Google Fonts. No frameworks, no build step.

## Pages

- `index.html` — home poster
- `about.html` — bio and contact
- `404.html` — not found (served by GitHub Pages)

## License
[MIT](https://choosealicense.com/licenses/mit/)
