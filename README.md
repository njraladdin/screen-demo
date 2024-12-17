<div align="center">
  <img src="src/assets/logo.svg" alt="Screen Demo Logo" width="120" height="120" />
  <h1>Screen Demo</h1>
  <p>An open-source screen recording and editing tool with zoom animation capabilities.<br/>A lightweight open-source alternative to Screen.studio.</p>
</div>

![Demo Screenshot](public/screenshot.png)

## Features

- **High Quality Screen Recording**
  - Multi-monitor support
  - 60 FPS recording
  - Hardware-accelerated encoding
  - Cursor movement capture

- **Simple Video Editing**
  - Add smooth zoom animations
  - Customize background styles
  - Adjust video scale and border radius
  - Enhanced cursor visualization
  - Trim video segments

- **Export Options** 
  - Export to WebM
  - Up to 4K resolution support
  - High bitrate options for quality

## Installation

1. Download the latest release for your platform from the [Releases](https://github.com/njraladdin/screen-demo/releases) page

2. Or build from source:
```bash
# Install dependencies
npm install

# Run in development
npm run tauri dev

# Build
npm run tauri build
```

## Usage

1. Click "Start Recording" and select your monitor
2. Record your screen
3. Stop recording when done
4. Add zoom animations by clicking "Add Zoom at Playhead" 
5. Adjust zoom level, position and timing
6. Export the final video

## Development

Built with:
- Tauri (Rust)
- React
- TypeScript
- Windows Capture API

Requirements:
- Node.js 16+
- Rust toolchain
- Windows 10+ (for screen capture)

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) for details.

