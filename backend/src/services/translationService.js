const translate = require('google-translate-api-x');

/**
 * Service to handle text translation using Google Translate API.
 */
class TranslationService {
    /**
     * Translates text to a target language.
     * @param {string} text - The text to translate.
     * @param {string} target - The target language code (default 'en').
     * @param {string} source - The source language code (default 'auto').
     * @returns {Promise<string>} - The translated text.
     */
    async translate(text, target = 'en', source = 'auto') {
        if (!text || text.trim() === '') {
            return '';
        }

        try {
            console.log(`[TranslationService] Translating to ${target}...`);

            // Add a timeout to prevent hanging the backend
            const translatePromise = translate(text, { to: target, from: source });
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Translation timed out after 10 seconds')), 10000)
            );

            const res = await Promise.race([translatePromise, timeoutPromise]);

            if (res && res.text) {
                return res.text;
            }

            throw new Error('Empty response from Google Translate');
        } catch (error) {
            console.error('[TranslationService] Error:', error.message);
            throw new Error(`Translation failed: ${error.message}`);
        }
    }
}

module.exports = new TranslationService();
