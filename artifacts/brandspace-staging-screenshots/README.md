# BrandSpace Staging Screenshots

Live staging capture from 2026-09-25.

- 114 full-page PNG screenshots
- Admin Simple + Advanced
- Customer Dashboard
- English + Arabic
- Desktop viewport: 1363 x 936
- Full coverage and limitations: `SCREENSHOT-MANIFEST.md`

The verified ZIP is stored here as ordered binary parts because the connector upload surface has a per-request payload limit.

Rebuild it from this directory:

```bash
cat brandspace-staging-complete-screenshots.zip.part-* > brandspace-staging-complete-screenshots.zip
sha256sum brandspace-staging-complete-screenshots.zip
```

Expected SHA-256:

```text
ebfe80627e96ccac7258fdadc330706a56b5d5d1fb6ef5bb26f8709ba1ec5b29
```

The reconstructed ZIP contains one flat folder named `brandspace-staging-screenshots/` with all PNG files and `SCREENSHOT-MANIFEST.md`.
