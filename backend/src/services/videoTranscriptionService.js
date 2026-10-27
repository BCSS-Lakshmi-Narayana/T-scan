/**
 * Video Transcription Service - Whisper Only (No Sarvam)
 *
 * Downloads a media URL → converts to 16kHz mono WAV via ffmpeg →
 * transcribes via local @xenova/transformers Whisper Large V3 Turbo.
 * Returns the transcript string or null on failure.
 * 
 * Tenant isolation is handled at mediaTranscriptUtils layer via feature flags.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const axios = require('axios');

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB safety cap
const CHUNK_SECS = 25;

function downloadHeaders(url) {
    const h = { 'User-Agent': 'Mozilla/5.0 (compatible; SagaBot/1.0)' };
    if (url.includes('twimg.com')) {
        h['Referer'] = 'https://twitter.com/';
        h['Origin'] = 'https://twitter.com';
    } else if (url.includes('fbcdn.net') || url.includes('facebook.com')) {
        h['Referer'] = 'https://www.facebook.com/';
    } else if (url.includes('cdninstagram.com') || url.includes('instagram.com')) {
        h['Referer'] = 'https://www.instagram.com/';
    }
    return h;
}

async function downloadToFile(url, destPath) {
    const response = await axios.get(url, {
        responseType: 'stream',
        headers: downloadHeaders(url),
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: MAX_VIDEO_BYTES,
        maxBodyLength: MAX_VIDEO_BYTES,
    });
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(destPath);
        response.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        response.data.on('error', reject);
    });
}

function convertToWav(inputPath, outputPath) {
    execSync(`ffmpeg -y -i "${inputPath}" -vn -ar 16000 -ac 1 -f wav "${outputPath}"`, { stdio: 'pipe' });
}

function getDurationSecs(wavPath) {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`, { stdio: 'pipe' }).toString().trim();
    return parseFloat(out) || 0;
}

function splitWav(wavPath, maxSecs) {
    const total = getDurationSecs(wavPath);
    if (total <= maxSecs) return [wavPath];
    const n = Math.ceil(total / maxSecs);
    const chunks = [];
    for (let i = 0; i < n; i++) {
        const cp = wavPath.replace('.wav', `_c${i}.wav`);
        execSync(`ffmpeg -y -i "${wavPath}" -ss ${i * maxSecs} -t ${maxSecs} -c copy "${cp}"`, { stdio: 'pipe' });
        chunks.push(cp);
    }
    return chunks;
}

async function transcribeChunkLocal(wavPath) {
    // Use @xenova/transformers for local Whisper inference
    try {
        const { pipeline } = await import('@xenova/transformers');
        const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-large-v3-turbo');
        const result = await transcriber(wavPath, { language: 'en' });
        return result.text || '';
    } catch (err) {
        console.warn(`[Whisper] Local transcription failed: ${err.message}`);
        return null;
    }
}

async function transcribeChunk(wavPath) {
    const log = (msg) => console.log(`[Whisper] ${msg}`);
    log(`Transcribing ${path.basename(wavPath)} with local Whisper...`);
    return await transcribeChunkLocal(wavPath);
}

function cleanup(...paths) {
    for (const p of paths) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { }
    }
}

async function transcribeVideoUrl(videoUrl, language = 'en') {
    const log = (msg) => console.log(`[VideoTranscribe] ${msg}`);

    // Skip unsupported URL types
    if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be') || videoUrl.includes('.m3u8')) {
        log(`Skipping unsupported URL type: ${videoUrl.substring(0, 60)}`);
        return null;
    }

    const ts = Date.now();
    const tmpDir = os.tmpdir();
    const ext = videoUrl.match(/\.(mp4|webm|mov|mkv|mp3|m4a|wav)(\?|$)/i)?.[1] || 'mp4';
    const rawPath = path.join(tmpDir, `saga_whisper_${ts}.${ext}`);
    const wavPath = path.join(tmpDir, `saga_whisper_${ts}.wav`);
    let chunkPaths = [];

    try {
        log(`Downloading media: ${videoUrl.substring(0, 80)}`);
        await downloadToFile(videoUrl, rawPath);

        log('Converting to WAV...');
        convertToWav(rawPath, wavPath);

        const chunks = splitWav(wavPath, CHUNK_SECS);
        chunkPaths = chunks.filter(c => c !== wavPath);

        const parts = [];
        for (let i = 0; i < chunks.length; i++) {
            log(`Transcribing chunk ${i + 1}/${chunks.length}...`);
            const text = await transcribeChunk(chunks[i]);
            if (text) parts.push(text.trim());
        }

        const transcript = parts.join(' ').trim();
        log(`Transcript complete (${transcript.length} chars): "${transcript.substring(0, 80)}..."`);
        return transcript || null;
    } catch (err) {
        log(`Transcription failed: ${err.message}`);
        return null;
    } finally {
        cleanup(rawPath, wavPath, ...chunkPaths);
    }
}

module.exports = { transcribeVideoUrl };
