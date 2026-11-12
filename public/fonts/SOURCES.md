# Font sources

Copied once from the owner's staging site (staging.nare.am), which self-hosts them via next/font (SIL Open Font Licence 1.1 families):

| File | Family / subset | Staging path |
|---|---|---|
| inter-latin.woff2, inter-latin-ext.woff2 | Inter (variable 100-900) | /_next/static/media/83afe278b6a6bb3c-s.p.3a6ba036.woff2, 1bffadaabf893a1e-s.7cd81963.woff2 |
| fraunces-latin.woff2, fraunces-latin-ext.woff2 | Fraunces (variable, optical size axis) | /_next/static/media/791bf8c4bb753ed6-s.p.fb4c44d9.woff2, e455bcff747f0d5e-s.5f7c7356.woff2 |
| noto-sans-armenian.woff2 | Noto Sans Armenian (body, Armenian) | /_next/static/media/2dfa23f74893c739-s.p.3ca22f0f.woff2 |
| noto-serif-armenian.woff2 | Noto Serif Armenian (Armenian headings) | /_next/static/media/4bbee4715c9988bf-s.p.646a3374.woff2 |

Staging stacks mirrored in app/globals.css: body `Inter, Noto Sans Armenian, system-ui`; `.font-display` `Fraunces` (Armenian: `Noto Serif Armenian`).
