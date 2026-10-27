const puppeteer = require('puppeteer');

let browserPromise = null;

const getBrowser = async () => {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        browserPromise.catch(() => { browserPromise = null; });
    }
    const browser = await browserPromise;
    if (!browser.connected) {
        browserPromise = null;
        return getBrowser();
    }
    return browser;
};

const escapeHtml = (str = '') =>
    String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

/**
 * Clean stylesheet for the "templateHtml" path. We control everything here —
 * no captured frontend CSS, no Tailwind utility classes, no inline padding
 * from the rich text editor. @page provides per-page margins so pagination
 * across multiple physical pages stays consistent.
 */
const CLEAN_TEMPLATE_STYLES = `
    @page {
        size: A4;
        margin: 25mm 20mm 18mm 20mm;
    }

    /* MATCH the on-screen RichTextEditor exactly so text wraps at the same
       points — otherwise different glyph widths shift line breaks and you
       get orphaned words with big gaps. Editor uses:
         font-family: serif (browser default serif)
         font-size:   15.5px
         line-height: 1.7
         text-align:  left
    */
    html, body {
        margin: 0;
        padding: 0;
        background: #fff;
        color: #000;
        /* Pin the exact font — "serif" can resolve to Liberation Serif /
           DejaVu Serif on headless Chromium and shift glyph widths, which
           breaks WYSIWYG wrapping versus the browser's Times New Roman. */
        font-family: 'Times New Roman', Times, 'Liberation Serif', serif;
        font-size: 15.5px;
        line-height: 1.7;
        text-align: left;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }

    /* Don't justify text by default — justify stretches spaces and creates
       awkward "river" gaps on lines like "Portal     (NCRP) is ..." that
       look fine left-aligned in the editor. */
    p, div, li, td, th { text-align: left; }
    /* But respect explicit text-align set on individual elements via inline
       style or style attr (the user can still author centered/justified
       text in the editor). Inline styles win over these rules. */

    /* Preserve any whitespace the user authored in the template (multiple
       spaces, newlines, &nbsp;) so the rendered text matches the editor. */
    body { white-space: normal; }
    body * { word-break: break-word; overflow-wrap: break-word; }

    /* Reasonable defaults for the user-authored template HTML */
    p { margin: 0 0 1em 0; }
    h1, h2, h3, h4, h5, h6 { margin: 0 0 0.6em 0; font-weight: bold; }

    a { color: inherit; text-decoration: underline; }
    img, svg { max-width: 100%; height: auto; }

    table { width: 100%; border-collapse: collapse; margin: 0 0 10pt 0; }
    th, td { border: 1px solid #333; padding: 6pt 10pt; vertical-align: top; }
    th { background: #f0f0f0; font-weight: bold; }

    ul, ol { margin: 0 0 10pt 0; padding-left: 20pt; }
    li { margin: 0 0 4pt 0; }

    /* Avoid awkward breaks */
    h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
    p, li, blockquote, pre, table { page-break-inside: avoid; break-inside: avoid; }

    /* Preserve authored colors */
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

    /* The user's template HTML lands directly in <body> with no extra wrapper */
`;

/**
 * Render a complete HTML document to PDF with a RefNo footer.
 *
 * Two modes:
 *  1. CLEAN MODE (preferred for custom templates) — pass `templateHtml`.
 *     The user's authored template content is dropped into a server-controlled
 *     A4 document. No frontend CSS, no cascade fights, predictable margins.
 *  2. LEGACY MODE — pass `headHtml` + `bodyHtml`. Used as a fallback for the
 *     default React-rendered report. Tries to clone the live page's styling.
 */
const renderReportPdf = async ({
    headHtml = '',
    bodyHtml = '',
    templateHtml = '',
    serialNumber = '',
}) => {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });

        let doc;
        if (templateHtml) {
            // CLEAN MODE — no frontend styles, no captured DOM. Just the
            // user's template content inside a controlled A4 wrapper.
            doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>${CLEAN_TEMPLATE_STYLES}</style>
</head>
<body>
${templateHtml}
</body>
</html>`;
        } else {
            // LEGACY MODE — clone the live page's head and inject overrides.
            doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<base href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/" />
${headHtml}
<style>
    @page { size: A4; margin: 25mm 20mm 18mm 20mm; }
    html, body {
        margin: 0 !important;
        padding: 0 !important;
        background: #fff !important;
        color: #000 !important;
    }
    .no-print, .no-print-workspace, nav, aside, button, header.no-print { display: none !important; }
    .print-area {
        width: 100% !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        display: block !important;
        gap: 0 !important;
    }
    .report-page, .report-page-sheet, .rte-sheet {
        width: 100% !important;
        min-height: 0 !important;
        height: auto !important;
        padding: 0 !important;
        margin: 0 !important;
        box-shadow: none !important;
        border: 0 !important;
        outline: 0 !important;
        background: #fff !important;
        page-break-after: always !important;
        page-break-inside: auto !important;
        overflow: visible !important;
    }
    .report-page:last-child, .report-page-sheet:last-child, .rte-sheet:last-child {
        page-break-after: auto !important;
    }
    .rte-workspace {
        padding: 0 !important;
        margin: 0 !important;
        background: transparent !important;
        overflow: visible !important;
        display: block !important;
    }
    .rte-sheet > [contenteditable],
    .rte-sheet > div[contenteditable="true"] {
        width: 100% !important;
        min-height: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        border: 0 !important;
        outline: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
    }
    [contenteditable] {
        border: 0 !important;
        background: transparent !important;
        outline: 0 !important;
    }
    * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
    }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
        }

        await page.setContent(doc, {
            waitUntil: ['load', 'domcontentloaded', 'networkidle0'],
            timeout: 60000,
        });

        await page.evaluate(async () => {
            if (document.fonts && document.fonts.ready) {
                await document.fonts.ready;
            }
        });

        const footer = `<div style="font-size:9px;width:100%;padding:0 20mm;color:#333;text-align:right;font-family:Arial,sans-serif;-webkit-print-color-adjust:exact;">RefNo:${escapeHtml(serialNumber)}</div>`;

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: footer,
            margin: { top: '25mm', bottom: '18mm', left: '20mm', right: '20mm' },
            preferCSSPageSize: false,
        });

        return pdf;
    } finally {
        await page.close().catch(() => {});
    }
};

module.exports = { renderReportPdf };
