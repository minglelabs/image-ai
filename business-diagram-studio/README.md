# Business Diagram Studio

Business Diagram Studio is a React/Vite canvas app for quickly creating Venn diagrams and competitive quadrant charts from structured inputs.

## Features

- Open an existing project or create a new project from the home screen
- Choose between `Venn Diagram` and `Competitive Quadrant`
- Edit directly on a canvas
  - Add text boxes
  - Attach multiple images
  - Drag text and image elements
  - Resize text and image elements
- Venn-specific inputs
  - Set names
  - Add set icons or images
  - Add service names and icons
- Quadrant-specific inputs
  - Set x-axis and y-axis labels
  - Add service names and icons
- Local source-of-truth persistence
  - File-based storage in `.project-saves/*.business-diagram-project.json`
  - Automatic save every 100ms

## Getting started

```bash
cd business-diagram-studio
npm install
npm run dev
```

`npm run dev` starts the Vite web app and local API together.

## Build

```bash
npm run build
npm run preview
```
