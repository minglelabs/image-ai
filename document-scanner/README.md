# Document Scanner

Document Scanner turns smartphone photos of contracts and other paper documents into clean, scanner-style files directly in the browser.

## Features

- Select a paper preset: A4, B5, A5, or Letter
- Choose portrait or landscape orientation
- Move four crop points to isolate the document and correct perspective distortion
- Fit the selected area to the exact paper aspect ratio
- Remove color cast, uneven lighting, shadows, and paper curvature with a local canvas pipeline
- Choose document black-and-white, soft grayscale, or color-preserving output
- Tune contrast and sharpness
- Export a high-resolution PNG
- Keep source images on the device; no upload API is used

## Getting started

```bash
npm install
npm run dev
```

The Vite development server runs on port `4330`.

## Build

```bash
npm run build
```

The build output is generated in `dist/`.
