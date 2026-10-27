const Tenant = require('../models/Tenant');

const normalizeText = (value) => String(value || '').trim();

const isTranscriptableMedia = (mediaItem) => {
    const type = String(mediaItem?.type || '').toLowerCase();
    const url = String(mediaItem?.s3_url || mediaItem?.video_url || mediaItem?.url || mediaItem?.original_video_url || mediaItem?.original_url || '').trim();
    if (!url) return false;
    return ['video', 'audio', 'animated_gif', 'voice'].includes(type) || /\.(mp4|mov|m4v|mkv|webm|mp3|m4a|wav|ogg|aac)(\?|$)/i.test(url);
};

const isMediaTranscriptionEnabled = async (tenantId, fallback = true) => {
    if (process.env.ENABLE_MEDIA_TRANSCRIPTION === 'false') return false;
    if (process.env.ENABLE_MEDIA_TRANSCRIPTION === 'true') return true;
    if (!tenantId) return fallback;

    try {
        const tenant = await Tenant.findOne({ id: tenantId }).select('feature_flags').lean();
        const flagValue = tenant?.feature_flags?.enable_media_transcription;
        return typeof flagValue === 'boolean' ? flagValue : fallback;
    } catch (err) {
        console.warn(`[MediaTranscript] Tenant flag lookup failed for ${tenantId}: ${err.message}`);
        return fallback;
    }
};

const buildTextWithTranscript = async ({ text, media = [], transcribeFn, tenantId = null }) => {
    const originalText = normalizeText(text);
    const enabled = await isMediaTranscriptionEnabled(tenantId, true);

    if (!enabled || !Array.isArray(media) || media.length === 0 || typeof transcribeFn !== 'function') {
        return originalText;
    }

    const transcriptParts = [];
    for (const item of media) {
        if (!isTranscriptableMedia(item)) continue;
        const url = String(item?.s3_url || item?.video_url || item?.url || item?.original_video_url || item?.original_url || '').trim();
        if (!url) continue;
        try {
            const transcript = await transcribeFn(url);
            if (transcript && normalizeText(transcript)) {
                transcriptParts.push(normalizeText(transcript));
            }
        } catch (err) {
            console.warn(`[MediaTranscript] Failed to transcribe media URL ${url}: ${err.message}`);
        }
    }

    if (transcriptParts.length === 0) {
        return originalText;
    }

    const transcriptBlock = transcriptParts.join('\n');
    return originalText
        ? `${originalText}\n\n[MEDIA TRANSCRIPT]:\n${transcriptBlock}`
        : `[MEDIA TRANSCRIPT]:\n${transcriptBlock}`;
};

module.exports = { buildTextWithTranscript, isMediaTranscriptionEnabled };
