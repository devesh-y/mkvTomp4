# MKV to MP4 Converter (Audio Select + Burned Subtitles)

Local app with:
- React + Vite frontend
- Node backend that calls installed `ffprobe` / `ffmpeg`
- Per-file selection of one audio stream and one subtitle stream
- MP4 output with subtitle burned into video (not kept as a subtitle track)

## Prerequisites

- Node.js 20+
- `ffmpeg` installed and available in PATH
- `ffprobe` installed and available in PATH

Check:

```bash
ffmpeg -version
ffprobe -version
```

## Run

From project root:

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787`

## How to Use

1. Paste absolute folder path containing `.mkv` files.
2. Click **Scan Folder**.
3. For each file, select:
   - one audio stream
   - one subtitle stream to burn
4. Set concurrency (1-6, default 3).
5. Click **Convert**.

Output goes to: `<input-folder>/output/*.mp4`.

## Notes

- Subtitle burn requires video re-encode (`libx264`).
- Audio is encoded to AAC (`192k`) for broad MP4 compatibility.
- Burn step supports text subtitle codecs only (`subrip`, `ass`, `ssa`, `mov_text`).
- Browser cannot reliably read full local folder path from drag/drop due to sandbox rules, so path paste is the reliable method.

## Example ffmpeg shape

```bash
ffmpeg -i input.mkv \
  -map 0:v:0 -map 0:<audioStreamIndex> \
  -c:v libx264 -preset medium -crf 20 \
  -vf "subtitles=input.mkv:si=<subtitleStreamIndex>" \
  -c:a aac -b:a 192k -movflags +faststart -sn \
  output.mp4
```
