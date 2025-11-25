const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main render endpoint
app.post('/render', async (req, res) => {
  const tmpDir = '/tmp'; // works on Render / Railway etc.

  try {
    // ✅ CHANGE 1: expect `audio` (with .data) instead of `audioUrl`
    const { clips = [], audio, captions = [], output = {} } = req.body;

    if (!clips.length) {
      return res.status(400).json({ error: 'No clips provided' });
    }
    if (!audio || !audio.data) {
      return res.status(400).json({ error: 'audio.data (base64) is required' });
    }

    // For v1: just use the first clip
    const mainClip = clips[0];

    const videoPath = path.join(tmpDir, 'video.mp4');
    const audioPath = path.join(tmpDir, 'audio.mp3');
    const outPath = path.join(tmpDir, `out-${Date.now()}.mp4`);

    // Helper to download a file (still used for the video clip)
    async function downloadFile(url, dest) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
      }

      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(dest);
        response.body.pipe(fileStream);
        response.body.on('error', reject);
        fileStream.on('finish', resolve);
      });
    }

    // ✅ CHANGE 2: download only the video via URL
    await downloadFile(mainClip.url || mainClip.link, videoPath);

    // ✅ CHANGE 3: write the audio from base64 into audioPath
    const audioBuffer = Buffer.from(audio.data, 'base64');
    fs.writeFileSync(audioPath, audioBuffer);

    // Output resolution (default: 1080x1920 vertical)
    const width = output.width || 1080;
    const height = output.height || 1920;

    // Build the video:
    // - take videoPath
    // - swap in audioPath
    // - scale to vertical
    // - stop when the shorter of video/audio ends (-shortest)
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .input(audioPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(`${width}x${height}`)
        .outputOptions(['-shortest'])
        .on('end', resolve)
        .on('error', reject)
        .save(outPath);
    });

    // Stream the output back to the caller
    const stat = fs.statSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(outPath);
    readStream.pipe(res);

    readStream.on('close', () => {
      // Cleanup temp files
      fs.unlink(videoPath, () => {});
      fs.unlink(audioPath, () => {});
      fs.unlink(outPath, () => {});
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({
      error: err.message || 'Render failed',
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Video builder listening on port', PORT);
});
