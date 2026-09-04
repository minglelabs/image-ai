# PDF Manager

PDF Manager is a browser-based utility for combining JPG, JPEG, PNG, HEIC, and HEIF files into a single PDF, or exporting every page of a PDF as a separate image.

All processing happens locally in the browser. Files are not uploaded to a server.

## Features

- Add multiple JPG, JPEG, PNG, HEIC, or HEIF images with drag and drop or a file picker
- Reorder, remove, and preview pages before creating the PDF
- Choose A4, Letter, or original-size pages
- Choose automatic, portrait, or landscape page orientation
- Apply a page margin while preserving each image's aspect ratio
- Upload a PDF and preview every page
- Export PDF pages as PNG or JPEG files in one ZIP archive
- Show processing progress and clear error messages for unsupported files

## Getting started

```bash
cd pdf-manager
pnpm install
pnpm dev
```

The Vite development server runs on port `4340`.

## Build

```bash
pnpm build
```

The production output is generated in `dist/`.
