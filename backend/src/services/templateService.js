const mammoth = require('mammoth');

/**
 * Clean up HTML produced by mammoth — strip invisible characters,
 * collapse redundant whitespace, and normalise empty elements.
 */
const sanitizeHtml = (html) => {
    let out = html;

    // 1. Strip zero-width / invisible Unicode characters
    //    U+200B zero-width space, U+200C/D joiners, U+FEFF BOM, U+00AD soft-hyphen,
    //    U+2060 word joiner, U+200E/F LTR/RTL marks
    out = out.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u200E\u200F]/g, '');

    // 2. Convert non-breaking spaces to regular spaces (except intentional &nbsp;)
    out = out.replace(/\u00A0/g, ' ');

    // 3. Collapse runs of multiple spaces into one (inside text nodes, not attributes)
    out = out.replace(/>(\s{2,})</g, '> <');

    // 4. Remove completely empty paragraphs that mammoth generates for blank DOCX lines
    //    (keep <p><br></p> which represent intentional blank lines)
    out = out.replace(/<p>\s*<\/p>/gi, '');

    // 5. Trim leading/trailing whitespace inside paragraphs
    out = out.replace(/<p>\s+/gi, '<p>');
    out = out.replace(/\s+<\/p>/gi, '</p>');

    return out;
};

/**
 * Mammoth style map — preserve DOCX formatting that vanilla mammoth drops.
 */
const STYLE_MAP = [
    // Map bold runs to <strong>
    "b => strong",
    // Map italic runs to <em>
    "i => em",
    // Map underline to <u>
    "u => u",
    // Map strikethrough
    "strike => s",
    // Heading styles
    "p[style-name='Heading 1'] => h1:fresh",
    "p[style-name='Heading 2'] => h2:fresh",
    "p[style-name='Heading 3'] => h3:fresh",
    "p[style-name='Heading 4'] => h4:fresh",
    "p[style-name='Title'] => h1.doc-title:fresh",
    "p[style-name='Subtitle'] => h2.doc-subtitle:fresh",
    // Preserve centered/right alignment via classes
    "p[style-name='Quote'] => blockquote:fresh",
    "p[style-name='Block Text'] => blockquote:fresh",
];

/**
 * Parse DOCX file to clean, editable HTML
 * @param {Buffer} buffer - DOCX file buffer
 * @returns {Promise<string>} HTML content
 */
const parseDocxToHtml = async (buffer) => {
    try {
        const result = await mammoth.convertToHtml(
            { buffer },
            {
                styleMap: STYLE_MAP,
                includeDefaultStyleMap: true,
                convertImage: mammoth.images.imgElement((image) => {
                    return image.read("base64").then((imageBuffer) => ({
                        src: `data:${image.contentType};base64,${imageBuffer}`,
                    }));
                }),
            }
        );

        // Log conversion warnings for debugging
        if (result.messages && result.messages.length > 0) {
            console.log('[TemplateService] Mammoth warnings:', result.messages.map(m => m.message));
        }

        return sanitizeHtml(result.value);
    } catch (error) {
        throw new Error(`Failed to parse DOCX: ${error.message}`);
    }
};

/**
 * Extract text from DOCX file
 * @param {Buffer} buffer - DOCX file buffer
 * @returns {Promise<string>} Plain text content
 */
const parseDocxToText = async (buffer) => {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch (error) {
        throw new Error(`Failed to extract text: ${error.message}`);
    }
};

module.exports = {
    parseDocxToHtml,
    parseDocxToText
};
