import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
    Bold, Italic, Underline, Strikethrough,
    AlignLeft, AlignCenter, AlignRight, AlignJustify,
    List, ListOrdered, Indent, Outdent,
    Undo2, Redo2, Eraser, Link2, ImageIcon, Minus,
    Heading1, Heading2, Heading3, Heading4,
    Superscript, Subscript, Palette, Highlighter,
    Table, Printer, Maximize2, Minimize2, FileText,
    Trash2, AlignHorizontalDistributeCenter, MoveHorizontal, Lock, Unlock
} from 'lucide-react';
import { Button } from './ui/button';

/* ───────── Page Size Config ───────── */
const PAGE_SIZES = {
    A4: { label: 'A4', width: '210mm', height: '297mm' },
    Letter: { label: 'Letter', width: '216mm', height: '279mm' },
    Legal: { label: 'Legal', width: '216mm', height: '356mm' },
    A3: { label: 'A3', width: '297mm', height: '420mm' },
    A5: { label: 'A5', width: '148mm', height: '210mm' },
    Auto: { label: 'Auto', width: '100%', height: 'auto' },
};

/* ───────── Toolbar Atom Components ───────── */
const ToolbarButton = ({ onClick, icon: Icon, title, active, className = '' }) => (
    <button
        type="button"
        onMouseDown={(e) => { e.preventDefault(); onClick(); }}
        className={`h-7 w-7 flex items-center justify-center rounded transition-colors
            ${active ? 'bg-primary/15 text-primary' : 'hover:bg-slate-100 text-slate-600'}
            ${className}`}
        title={title}
    >
        <Icon className="h-3.5 w-3.5" />
    </button>
);

const ToolbarDivider = () => (
    <div className="w-px h-6 bg-slate-200 mx-0.5" />
);

/* ───────── Main Component ───────── */
const RichTextEditor = ({
    initialContent = '',
    onChange,
    minHeight = '400px',
    showPrint = false,
    showStatusBar = true,
    className = '',
    placeholder = 'Start editing...',
    serialNumber = '',
    documentTitle = 'Official Notice',
    variant = 'full', // 'full' (with workspace) or 'minimal' (just toolbar + sheet)
    stickyOffset = 'top-0'
}) => {
    const editorRef = useRef(null);
    const debounceRef = useRef(null);
    const imageInputRef = useRef(null);
    const [selectedImage, setSelectedImage] = useState(null);
    const [imageToolbar, setImageToolbar] = useState(null);
    const resizeRef = useRef(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showLinkDialog, setShowLinkDialog] = useState(false);
    const [linkUrl, setLinkUrl] = useState('');
    const [showTableDialog, setShowTableDialog] = useState(false);
    const [tableRows, setTableRows] = useState(3);
    const [tableCols, setTableCols] = useState(3);
    const [pageSize, setPageSize] = useState('A4');
    const [lineHeight, setLineHeight] = useState('1.7');
    const [isEmpty, setIsEmpty] = useState(true);
    const contentSetRef = useRef(false);

    /* ── Clean invisible characters from any HTML content ── */
    const cleanInvisibleChars = useCallback((html) => {
        if (!html) return html;
        return html
            // Zero-width spaces, joiners, BOM, soft-hyphen, word joiner, LTR/RTL marks
            .replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u200E\u200F]/g, '')
            // Non-breaking spaces → regular spaces
            .replace(/\u00A0/g, ' ')
            // Word-specific XML tags
            .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '')
            // MSO styles
            .replace(/mso-[^;"']+:[^;"']+;?/gi, '')
            .replace(/class="Mso[^"]*"/gi, '');
    }, []);

    /* ── Set initial content only once ── */
    useEffect(() => {
        if (editorRef.current && initialContent && !contentSetRef.current) {
            editorRef.current.innerHTML = cleanInvisibleChars(initialContent);
            contentSetRef.current = true;
            setIsEmpty(!initialContent.trim());
        }
    }, [initialContent, cleanInvisibleChars]);

    /* ── Enable all editing features ── */
    useEffect(() => {
        document.execCommand('defaultParagraphSeparator', false, 'p');
        document.execCommand('styleWithCSS', false, true);
    }, []);

    /* ── Core exec wrapper ── */
    const exec = useCallback((command, value = null) => {
        document.execCommand(command, false, value);
        editorRef.current?.focus();
        if (onChange) {
            setTimeout(() => onChange(editorRef.current?.innerHTML || ''), 0);
        }
    }, [onChange]);

    /* ── Notify parent of changes (Debounced for performance) ── */
    const notifyChange = useCallback(() => {
        if (editorRef.current) {
            const html = editorRef.current.innerHTML || '';
            const text = editorRef.current.innerText.trim();
            setIsEmpty(!text || text === '\n');

            if (onChange) {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(() => {
                    onChange(html);
                }, 300);
            }
        }
    }, [onChange]);

    /* ── Handle input (typing) ── */
    const handleInput = useCallback(() => {
        notifyChange();
    }, [notifyChange]);

    /* ═══════════════════════════════════════════
       KEY HANDLER — Tab, Backspace, Enter, etc.
       ═══════════════════════════════════════════ */
    const handleKeyDown = useCallback((e) => {
        /* ── Tab key: insert 4 spaces or indent list ── */
        if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();

            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;

            // Check if we're inside a list item
            let node = sel.anchorNode;
            let inList = false;
            while (node && node !== editorRef.current) {
                if (node.nodeName === 'LI' || node.nodeName === 'UL' || node.nodeName === 'OL') {
                    inList = true;
                    break;
                }
                node = node.parentNode;
            }

            if (inList) {
                // Indent / outdent list items
                if (e.shiftKey) {
                    document.execCommand('outdent', false, null);
                } else {
                    document.execCommand('indent', false, null);
                }
            } else {
                // Handle indentation for normal text
                if (e.shiftKey) {
                    document.execCommand('outdent', false, null);
                } else {
                    // Use standard spaces for indentation
                    const sel = window.getSelection();
                    if (sel.rangeCount > 0) {
                        const range = sel.getRangeAt(0);
                        if (!sel.isCollapsed) {
                            document.execCommand('indent', false, null);
                        } else {
                            // Insert non-breaking spaces for visible indentation
                            document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
                        }
                    }
                }
            }
            notifyChange();
            return;
        }

        /* ── Enter key: ensure proper paragraph creation ── */
        if (e.key === 'Enter' && !e.shiftKey) {
            // Let the browser handle Enter normally for paragraph creation
            // execCommand('defaultParagraphSeparator', 'p') handles this
            setTimeout(notifyChange, 0);
            return;
        }

        /* ── Shift+Enter: insert line break ── */
        if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            document.execCommand('insertLineBreak', false, null);
            notifyChange();
            return;
        }

        /* ── Backspace/Delete: remove selected image or handle normally ── */
        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (selectedImage) {
                e.preventDefault();
                selectedImage.remove();
                setSelectedImage(null);
                setImageToolbar(null);
                document.querySelectorAll('.rte-img-selected').forEach(el => el.classList.remove('rte-img-selected'));
                notifyChange();
                return;
            }
            // Don't prevent default — let browser handle deletion naturally
            setTimeout(notifyChange, 0);
            return;
        }

        /* ── Keyboard shortcuts ── */
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'b':
                    e.preventDefault();
                    exec('bold');
                    break;
                case 'i':
                    e.preventDefault();
                    exec('italic');
                    break;
                case 'u':
                    e.preventDefault();
                    exec('underline');
                    break;
                case 'z':
                    e.preventDefault();
                    if (e.shiftKey) exec('redo');
                    else exec('undo');
                    break;
                case 'y':
                    e.preventDefault();
                    exec('redo');
                    break;
                case 'a':
                    // Select all within editor only
                    e.preventDefault();
                    const range = document.createRange();
                    range.selectNodeContents(editorRef.current);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    break;
                default:
                    break;
            }
        }
    }, [exec, notifyChange, selectedImage]);

    /* ── Image upload (file → base64 embed) ── */
    const insertImageFromFile = useCallback((file) => {
        if (!file || !file.type.startsWith('image/')) return;
        if (file.size > 10 * 1024 * 1024) {
            alert('Image too large. Maximum size is 10 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            const base64 = ev.target.result;
            const imgHtml = `<img src="${base64}" class="rte-img" style="max-width:100%;height:auto;display:inline-block;vertical-align:top;margin:4px;cursor:pointer;" alt="Uploaded image" />`;
            editorRef.current?.focus();
            document.execCommand('insertHTML', false, imgHtml);
            notifyChange();
        };
        reader.readAsDataURL(file);
    }, [notifyChange]);

    /* ── Paste handler — sanitize hidden characters + allow rich paste ── */
    const handlePaste = useCallback((e) => {
        /* ── Handle pasted images from clipboard (screenshots, copied images) ── */
        const items = e.clipboardData?.items;
        if (items) {
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) insertImageFromFile(file);
                    return;
                }
            }
        }

        const html = e.clipboardData?.getData('text/html');
        const text = e.clipboardData?.getData('text/plain');

        /**
         * Strip invisible Unicode characters that Word/WPS/Google Docs inject.
         * These cause "hidden spaces" where the cursor gets stuck.
         */
        const stripInvisible = (str) => str
            // Zero-width spaces, joiners, BOM, soft hypen, word joiner, LTR/RTL marks
            .replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u200E\u200F]/g, '')
            // Non-breaking spaces → regular spaces
            .replace(/\u00A0/g, ' ');

        if (html && !e.shiftKey) {
            e.preventDefault();
            let sanitizedHtml = html;

            // Strip invisible characters
            sanitizedHtml = stripInvisible(sanitizedHtml);

            // Remove Word/WPS local resource links
            if (sanitizedHtml.includes('file:///')) {
                sanitizedHtml = sanitizedHtml.replace(/src="file:\/\/\/[^"]*"/gi, 'src="" alt="[Local Image — Please re-upload if missing]"');
                sanitizedHtml = sanitizedHtml.replace(/href="file:\/\/\/[^"]*"/gi, 'href="#"');
            }

            // Strip Word-specific XML / mso- styles that create invisible formatting
            sanitizedHtml = sanitizedHtml.replace(/<o:p>[\s\S]*?<\/o:p>/gi, '');
            sanitizedHtml = sanitizedHtml.replace(/mso-[^;"']+:[^;"']+;?/gi, '');
            sanitizedHtml = sanitizedHtml.replace(/class="Mso[^"]*"/gi, '');

            document.execCommand('insertHTML', false, sanitizedHtml);
            notifyChange();
        } else if (text) {
            e.preventDefault();
            const cleanText = stripInvisible(text);
            document.execCommand('insertText', false, cleanText);
            notifyChange();
        } else {
            setTimeout(notifyChange, 0);
        }
    }, [notifyChange, insertImageFromFile]);

    /* ── Image selection & resize ── */
    const clearImageSelection = useCallback(() => {
        setSelectedImage(null);
        setImageToolbar(null);
        document.querySelectorAll('.rte-img-selected').forEach(el => el.classList.remove('rte-img-selected'));
    }, []);

    const updateImageToolbarPosition = useCallback((img) => {
        const editorEl = editorRef.current;
        if (!editorEl || !img) return;
        const editorRect = editorEl.closest('.rte-workspace')?.getBoundingClientRect() || editorEl.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        setImageToolbar({
            top: imgRect.top - editorRect.top - 44,
            left: imgRect.left - editorRect.left + (imgRect.width / 2),
            width: Math.round(img.offsetWidth),
            height: Math.round(img.offsetHeight),
        });
    }, []);

    const handleImageClick = useCallback((e) => {
        const img = e.target.closest('img');
        if (!img || !editorRef.current?.contains(img)) {
            if (selectedImage) clearImageSelection();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        document.querySelectorAll('.rte-img-selected').forEach(el => el.classList.remove('rte-img-selected'));
        img.classList.add('rte-img-selected');
        setSelectedImage(img);
        updateImageToolbarPosition(img);
    }, [selectedImage, clearImageSelection, updateImageToolbarPosition]);

    const handleResizeStart = useCallback((e, handle) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selectedImage) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = selectedImage.offsetWidth;
        const startH = selectedImage.offsetHeight;
        const aspectRatio = startW / startH;
        const isCorner = ['nw', 'ne', 'sw', 'se'].includes(handle);

        const onMove = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let newW = startW;
            let newH = startH;

            if (handle.includes('e')) newW = Math.max(30, startW + dx);
            if (handle.includes('w')) newW = Math.max(30, startW - dx);
            if (handle.includes('s')) newH = Math.max(30, startH + dy);
            if (handle.includes('n')) newH = Math.max(30, startH - dy);

            if (isCorner && !ev.shiftKey) {
                // Maintain aspect ratio for corners (hold Shift to free-resize)
                newH = newW / aspectRatio;
            }

            selectedImage.style.width = newW + 'px';
            selectedImage.style.height = isCorner && !ev.shiftKey ? newH + 'px' : newH + 'px';
            selectedImage.style.maxWidth = 'none';
            updateImageToolbarPosition(selectedImage);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            notifyChange();
            updateImageToolbarPosition(selectedImage);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [selectedImage, notifyChange, updateImageToolbarPosition]);

    const setImageAlignment = useCallback((align) => {
        if (!selectedImage) return;
        if (align === 'inline') {
            selectedImage.style.display = 'inline-block';
            selectedImage.style.verticalAlign = 'top';
            selectedImage.style.float = 'none';
            selectedImage.style.margin = '4px';
        } else if (align === 'center') {
            selectedImage.style.display = 'block';
            selectedImage.style.float = 'none';
            selectedImage.style.margin = '8px auto';
        } else if (align === 'left') {
            selectedImage.style.display = 'block';
            selectedImage.style.float = 'left';
            selectedImage.style.margin = '4px 12px 4px 0';
        } else if (align === 'right') {
            selectedImage.style.display = 'block';
            selectedImage.style.float = 'right';
            selectedImage.style.margin = '4px 0 4px 12px';
        }
        notifyChange();
        setTimeout(() => updateImageToolbarPosition(selectedImage), 10);
    }, [selectedImage, notifyChange, updateImageToolbarPosition]);

    const setImageSize = useCallback((w, h) => {
        if (!selectedImage) return;
        selectedImage.style.width = w;
        selectedImage.style.height = h || 'auto';
        if (w !== '100%') selectedImage.style.maxWidth = 'none';
        else selectedImage.style.maxWidth = '100%';
        notifyChange();
        setTimeout(() => updateImageToolbarPosition(selectedImage), 10);
    }, [selectedImage, notifyChange, updateImageToolbarPosition]);

    const deleteSelectedImage = useCallback(() => {
        if (!selectedImage) return;
        selectedImage.remove();
        clearImageSelection();
        notifyChange();
    }, [selectedImage, clearImageSelection, notifyChange]);

    // Click outside editor to deselect image
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (selectedImage && !e.target.closest('.rte-img-toolbar') && !e.target.closest('img')) {
                clearImageSelection();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [selectedImage, clearImageSelection]);

    /* ── Focus handler — ensure cursor is inside editor ── */
    const handleFocus = useCallback(() => {
        if (editorRef.current && !editorRef.current.innerHTML.trim()) {
            // If editor is empty, create a paragraph to type in
            editorRef.current.innerHTML = '<p><br></p>';
            const range = document.createRange();
            const sel = window.getSelection();
            range.setStart(editorRef.current.firstChild, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }, []);

    /* ── Drop handler — allow drag-drop content + images ── */
    const handleDrop = useCallback((e) => {
        const files = e.dataTransfer?.files;
        if (files?.length > 0) {
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    e.preventDefault();
                    insertImageFromFile(file);
                    return;
                }
            }
        }
        setTimeout(notifyChange, 100);
    }, [notifyChange, insertImageFromFile]);

    /* ── Insert functions ── */
    const insertLink = () => {
        if (linkUrl) {
            exec('createLink', linkUrl);
            setLinkUrl('');
        }
        setShowLinkDialog(false);
    };

    const handleImageUpload = useCallback(() => {
        imageInputRef.current?.click();
    }, []);

    const handleImageFileChange = useCallback((e) => {
        const file = e.target.files?.[0];
        if (file) insertImageFromFile(file);
        e.target.value = '';
    }, [insertImageFromFile]);

    const insertTable = () => {
        let html = '<table style="width:100%;border-collapse:collapse;margin:12px 0;">';
        for (let r = 0; r < tableRows; r++) {
            html += '<tr>';
            for (let c = 0; c < tableCols; c++) {
                const tag = r === 0 ? 'th' : 'td';
                const style = r === 0
                    ? 'border:1px solid #999;padding:8px 12px;background:#f0f0f0;font-weight:bold;text-align:left;'
                    : 'border:1px solid #ccc;padding:8px 12px;';
                html += `<${tag} style="${style}">${r === 0 ? `Header ${c + 1}` : '&nbsp;'}</${tag}>`;
            }
            html += '</tr>';
        }
        html += '</table><p><br></p>';
        exec('insertHTML', html);
        setShowTableDialog(false);
    };

    const insertHR = () => {
        exec('insertHTML', '<hr style="border:none;border-top:2px solid #333;margin:16px 0;" /><p><br></p>');
    };

    const handlePrint = () => {
        const printContent = editorRef.current?.innerHTML || '';
        const ps = PAGE_SIZES[pageSize];
        const title = documentTitle || 'Official Notice';
        const refNumber = serialNumber || '';
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
            <html><head><title>${title}${refNumber ? ' - ' + refNumber : ''}</title>
            <style>
                @page {
                    size: ${ps.width} ${ps.height};
                    margin: 20mm 18mm 25mm 18mm;
                }
                html, body {
                    margin: 0; padding: 0;
                    font-family: 'Times New Roman', Georgia, serif;
                    font-size: 14px;
                    line-height: 1.7;
                    color: #000;
                    background: white;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }
                /* Running footer on every page */
                .print-footer {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    padding: 6px 0;
                    border-top: 1px solid #ccc;
                    font-size: 9px;
                    font-family: 'Inter', Arial, sans-serif;
                    font-weight: 700;
                    color: #000;
                    background: white;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    text-transform: uppercase;
                }
                /* Content area with bottom padding for footer clearance */
                .print-content {
                    padding-bottom: 30px;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    page-break-inside: avoid;
                    margin: 12px 0;
                }
                td, th {
                    border: 1px solid #333;
                    padding: 6px 10px;
                    font-size: 13px;
                }
                th {
                    background: #f0f0f0;
                    font-weight: bold;
                }
                h1 { font-size: 20px; margin: 12px 0 10px; }
                h2 { font-size: 18px; margin: 12px 0 8px; }
                h3 { font-size: 16px; margin: 12px 0 6px; }
                h4 { font-size: 14px; margin: 10px 0 6px; }
                p {
                    margin-bottom: 6px;
                    orphans: 3;
                    widows: 3;
                    text-align: justify;
                }
                a { color: inherit; text-decoration: underline; }
                img { max-width: 100%; page-break-inside: avoid; }
                blockquote, pre, ul, ol, table { page-break-inside: avoid; }
                blockquote {
                    border-left: 3px solid #999;
                    padding-left: 12px;
                    margin: 8px 0;
                    color: #555;
                }
                hr {
                    border: none;
                    border-top: 2px solid #333;
                    margin: 16px 0;
                }
            </style>
            </head>
            <body>
                ${refNumber ? `<div class="print-footer"><span>INTERNAL REF: ${refNumber}</span><span>Official Notice — ${refNumber}</span></div>` : ''}
                <div class="print-content">${printContent}</div>
            </body></html>
        `);
        printWindow.document.close();
        setTimeout(() => printWindow.print(), 300);
    };

    const currentPage = PAGE_SIZES[pageSize];
    const containerClass = isFullscreen
        ? 'fixed inset-0 z-50 bg-white flex flex-col'
        : variant === 'minimal'
            ? `flex flex-col ${className}`
            : `flex flex-col overflow-hidden bg-white h-full ${className}`;

    return (
        <div className={containerClass}>
            {/* ═══════════════ TOOLBAR ═══════════════ */}
            <div className={`bg-slate-50 border-b border-slate-200 px-2 py-1.5 flex flex-wrap items-center gap-0.5 no-print z-10 ${variant === 'minimal' ? `sticky ${stickyOffset}` : 'shrink-0'}`}>

                {/* Text Style */}
                <ToolbarButton onClick={() => exec('bold')} icon={Bold} title="Bold (Ctrl+B)" />
                <ToolbarButton onClick={() => exec('italic')} icon={Italic} title="Italic (Ctrl+I)" />
                <ToolbarButton onClick={() => exec('underline')} icon={Underline} title="Underline (Ctrl+U)" />
                <ToolbarButton onClick={() => exec('strikeThrough')} icon={Strikethrough} title="Strikethrough" />
                <ToolbarButton onClick={() => exec('superscript')} icon={Superscript} title="Superscript" />
                <ToolbarButton onClick={() => exec('subscript')} icon={Subscript} title="Subscript" />

                <ToolbarDivider />

                {/* Font Size */}
                <select
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => { exec('fontSize', e.target.value); }}
                    className="h-7 text-[11px] border rounded px-1 bg-white cursor-pointer hover:bg-slate-50"
                    defaultValue="3"
                    title="Font Size"
                >
                    <option value="1">8pt</option>
                    <option value="2">10pt</option>
                    <option value="3">12pt</option>
                    <option value="4">14pt</option>
                    <option value="5">18pt</option>
                    <option value="6">24pt</option>
                    <option value="7">36pt</option>
                </select>

                {/* Font Family */}
                <select
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => { exec('fontName', e.target.value); }}
                    className="h-7 text-[11px] border rounded px-1 bg-white cursor-pointer hover:bg-slate-50 w-28"
                    defaultValue="serif"
                    title="Font Family"
                >
                    <optgroup label="Generic">
                        <option value="serif">Serif</option>
                        <option value="sans-serif">Sans Serif</option>
                        <option value="monospace">Monospace</option>
                        <option value="cursive">Cursive</option>
                    </optgroup>
                    <optgroup label="Common Fonts">
                        <option value="Arial">Arial</option>
                        <option value="Arial Black">Arial Black</option>
                        <option value="Calibri">Calibri</option>
                        <option value="Cambria">Cambria</option>
                        <option value="Comic Sans MS">Comic Sans MS</option>
                        <option value="Courier New">Courier New</option>
                        <option value="Georgia">Georgia</option>
                        <option value="Helvetica">Helvetica</option>
                        <option value="Impact">Impact</option>
                        <option value="Lucida Console">Lucida Console</option>
                        <option value="Tahoma">Tahoma</option>
                        <option value="Times New Roman">Times New Roman</option>
                        <option value="Trebuchet MS">Trebuchet MS</option>
                        <option value="Verdana">Verdana</option>
                    </optgroup>
                    <optgroup label="Document Fonts">
                        <option value="Book Antiqua">Book Antiqua</option>
                        <option value="Garamond">Garamond</option>
                        <option value="Palatino Linotype">Palatino Linotype</option>
                        <option value="Century Gothic">Century Gothic</option>
                    </optgroup>
                    <optgroup label="Indian / Telugu">
                        <option value="Gautami">Gautami</option>
                        <option value="Nirmala UI">Nirmala UI</option>
                        <option value="Mangal">Mangal</option>
                        <option value="Latha">Latha</option>
                    </optgroup>
                </select>

                <ToolbarDivider />

                {/* Headings */}
                <select
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => { if (e.target.value) { exec('formatBlock', e.target.value); } e.target.selectedIndex = 0; }}
                    className="h-7 text-[11px] border rounded px-1 bg-white cursor-pointer hover:bg-slate-50 w-[90px]"
                    defaultValue=""
                    title="Block Format"
                >
                    <option value="" disabled>Format ▾</option>
                    <option value="<p>">Normal</option>
                    <option value="<h1>">Heading 1</option>
                    <option value="<h2>">Heading 2</option>
                    <option value="<h3>">Heading 3</option>
                    <option value="<h4>">Heading 4</option>
                    <option value="<h5>">Heading 5</option>
                    <option value="<h6>">Heading 6</option>
                    <option value="<pre>">Preformatted</option>
                    <option value="<blockquote>">Blockquote</option>
                </select>

                <ToolbarDivider />

                {/* Alignment */}
                <ToolbarButton onClick={() => exec('justifyLeft')} icon={AlignLeft} title="Align Left" />
                <ToolbarButton onClick={() => exec('justifyCenter')} icon={AlignCenter} title="Center" />
                <ToolbarButton onClick={() => exec('justifyRight')} icon={AlignRight} title="Align Right" />
                <ToolbarButton onClick={() => exec('justifyFull')} icon={AlignJustify} title="Justify" />

                <ToolbarDivider />

                {/* Lists & Indent */}
                <ToolbarButton onClick={() => exec('insertUnorderedList')} icon={List} title="Bullet List" />
                <ToolbarButton onClick={() => exec('insertOrderedList')} icon={ListOrdered} title="Numbered List" />
                <ToolbarButton onClick={() => exec('indent')} icon={Indent} title="Increase Indent (Tab)" />
                <ToolbarButton onClick={() => exec('outdent')} icon={Outdent} title="Decrease Indent (Shift+Tab)" />

                <ToolbarDivider />

                {/* Colors */}
                <div className="relative flex items-center" title="Text Color">
                    <Palette className="h-3 w-3 text-slate-500 absolute left-1 pointer-events-none" />
                    <input
                        type="color"
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => exec('foreColor', e.target.value)}
                        className="h-7 w-7 cursor-pointer opacity-0"
                        defaultValue="#000000"
                    />
                </div>
                <div className="relative flex items-center" title="Highlight Color">
                    <Highlighter className="h-3 w-3 text-slate-500 absolute left-1 pointer-events-none" />
                    <input
                        type="color"
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => exec('hiliteColor', e.target.value)}
                        className="h-7 w-7 cursor-pointer opacity-0"
                        defaultValue="#ffff00"
                    />
                </div>

                <ToolbarDivider />

                {/* Inserts */}
                <div className="relative">
                    <ToolbarButton onClick={() => setShowLinkDialog(!showLinkDialog)} icon={Link2} title="Insert Link" />
                    {showLinkDialog && (
                        <div className="absolute top-full left-0 mt-1 bg-white border rounded-lg shadow-lg p-2 z-20 flex gap-1 w-64">
                            <input
                                type="url"
                                value={linkUrl}
                                onChange={(e) => setLinkUrl(e.target.value)}
                                placeholder="https://..."
                                className="flex-1 h-7 text-xs border rounded px-2"
                                onKeyDown={(e) => { if (e.key === 'Enter') insertLink(); e.stopPropagation(); }}
                                autoFocus
                            />
                            <button onClick={insertLink} className="h-7 px-2 text-xs bg-primary text-white rounded hover:bg-primary/90">Add</button>
                        </div>
                    )}
                </div>
                <ToolbarButton onClick={handleImageUpload} icon={ImageIcon} title="Insert Image" />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleImageFileChange}
                    className="hidden"
                    tabIndex={-1}
                />
                <div className="relative">
                    <ToolbarButton onClick={() => setShowTableDialog(!showTableDialog)} icon={Table} title="Insert Table" />
                    {showTableDialog && (
                        <div className="absolute top-full left-0 mt-1 bg-white border rounded-lg shadow-lg p-3 z-20 w-48">
                            <p className="text-[10px] font-medium mb-2">Insert Table</p>
                            <div className="flex gap-2 mb-2">
                                <div>
                                    <label className="text-[10px] text-muted-foreground">Rows</label>
                                    <input type="number" min="1" max="20" value={tableRows} onChange={(e) => setTableRows(+e.target.value)} className="h-7 w-full text-xs border rounded px-2" />
                                </div>
                                <div>
                                    <label className="text-[10px] text-muted-foreground">Cols</label>
                                    <input type="number" min="1" max="10" value={tableCols} onChange={(e) => setTableCols(+e.target.value)} className="h-7 w-full text-xs border rounded px-2" />
                                </div>
                            </div>
                            <button onClick={insertTable} className="h-7 w-full text-xs bg-primary text-white rounded hover:bg-primary/90">Insert</button>
                        </div>
                    )}
                </div>
                <ToolbarButton onClick={insertHR} icon={Minus} title="Horizontal Rule" />

                <ToolbarDivider />

                {/* Undo / Redo / Clear */}
                <ToolbarButton onClick={() => exec('undo')} icon={Undo2} title="Undo (Ctrl+Z)" />
                <ToolbarButton onClick={() => exec('redo')} icon={Redo2} title="Redo (Ctrl+Y)" />
                <ToolbarButton onClick={() => exec('removeFormat')} icon={Eraser} title="Clear Formatting" className="text-red-400 hover:text-red-500" />

                <ToolbarDivider />

                {/* Line Spacing */}
                <div className="flex items-center gap-1" title="Line Spacing">
                    <span className="text-[10px] font-bold text-slate-400 ml-1">↕</span>
                    <select
                        value={lineHeight}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => setLineHeight(e.target.value)}
                        className="h-7 text-[11px] border rounded px-1 bg-white cursor-pointer hover:bg-slate-50 w-[55px]"
                    >
                        <option value="1.0">1.0</option>
                        <option value="1.15">1.15</option>
                        <option value="1.5">1.5</option>
                        <option value="1.7">1.7</option>
                        <option value="2.0">2.0</option>
                        <option value="2.5">2.5</option>
                    </select>
                </div>

                <ToolbarDivider />

                {/* Page Size */}
                <div className="flex items-center gap-1" title="Page Size">
                    <FileText className="h-3 w-3 text-slate-500" />
                    <select
                        value={pageSize}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => setPageSize(e.target.value)}
                        className="h-7 text-[11px] border rounded px-1 bg-white cursor-pointer hover:bg-slate-50 w-[70px]"
                        title="Page Size"
                    >
                        {Object.entries(PAGE_SIZES).map(([key, config]) => (
                            <option key={key} value={key}>{config.label}</option>
                        ))}
                    </select>
                </div>

                <ToolbarDivider />

                {/* Fullscreen & Print */}

                {/*<ToolbarButton
                    onClick={() => setIsFullscreen(!isFullscreen)}
                    icon={isFullscreen ? Minimize2 : Maximize2}
                    title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen'}
                /> */}
                {showPrint && (
                    <ToolbarButton onClick={handlePrint} icon={Printer} title="Print" />
                )}
            </div>

            {/* ═══════════════ EDITOR AREA (Workspace) ═══════════════ */}
            <div
                className={`flex-1 min-h-0 scroll-smooth rte-workspace no-print-bg select-text ${variant === 'minimal' ? 'bg-transparent py-0 px-0 overflow-visible' : 'overflow-auto bg-slate-100/50 py-12 px-4 flex justify-center items-start custom-scrollbar'}`}
            >
                {/* Centered A4 Sheet */}
                <div
                    className="mx-auto bg-white shadow-[0_0_15px_rgba(0,0,0,0.1)] border border-slate-200 relative transition-all duration-300 rte-sheet"
                    style={{
                        width: PAGE_SIZES[pageSize].width,
                        minHeight: PAGE_SIZES[pageSize].height === 'auto' ? '297mm' : PAGE_SIZES[pageSize].height
                    }}
                >
                    <div
                        ref={editorRef}
                        contentEditable
                        suppressContentEditableWarning
                        onInput={handleInput}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onFocus={handleFocus}
                        onDrop={handleDrop}
                        onClick={handleImageClick}
                        className={`outline-none cursor-text ${isEmpty ? 'rte-empty' : ''}`}
                        style={{
                            width: '100%',
                            minHeight: PAGE_SIZES[pageSize].height === 'auto' ? 'auto' : PAGE_SIZES[pageSize].height,
                            padding: '25mm 20mm', // Standard A4 margins
                            fontFamily: 'serif',
                            fontSize: '15.5px',
                            lineHeight: lineHeight,
                            textAlign: 'left',
                            boxSizing: 'border-box',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word',
                            whiteSpace: 'normal',
                            WebkitUserSelect: 'text',
                            MozUserSelect: 'text',
                            msUserSelect: 'text',
                            userSelect: 'text',
                            // NOTE: no background page-break band here. A CSS background
                            // gradient paints BEHIND the text, so the old grey "page gap"
                            // band rendered straight across content (cutting through
                            // paragraphs — the report "not rendering in pages" bug). The
                            // editing surface is now a clean continuous A4-width sheet;
                            // real page breaks are applied at PDF/print time via the
                            // reportPdfService @page rules.
                        }}
                        data-placeholder={placeholder}
                        spellCheck="true"
                        role="textbox"
                        aria-multiline="true"
                        tabIndex={0}
                    />

                    {/* ═══ Image Resize Handles ═══ */}
                    {selectedImage && (() => {
                        const editorEl = editorRef.current;
                        if (!editorEl) return null;
                        const imgRect = selectedImage.getBoundingClientRect();
                        const containerRect = editorEl.getBoundingClientRect();
                        const top = imgRect.top - containerRect.top;
                        const left = imgRect.left - containerRect.left;
                        const w = imgRect.width;
                        const h = imgRect.height;
                        const handles = [
                            { pos: 'nw', style: { top: top - 4, left: left - 4, cursor: 'nw-resize' } },
                            { pos: 'n', style: { top: top - 4, left: left + w / 2 - 4, cursor: 'n-resize' } },
                            { pos: 'ne', style: { top: top - 4, left: left + w - 4, cursor: 'ne-resize' } },
                            { pos: 'w', style: { top: top + h / 2 - 4, left: left - 4, cursor: 'w-resize' } },
                            { pos: 'e', style: { top: top + h / 2 - 4, left: left + w - 4, cursor: 'e-resize' } },
                            { pos: 'sw', style: { top: top + h - 4, left: left - 4, cursor: 'sw-resize' } },
                            { pos: 's', style: { top: top + h - 4, left: left + w / 2 - 4, cursor: 's-resize' } },
                            { pos: 'se', style: { top: top + h - 4, left: left + w - 4, cursor: 'se-resize' } },
                        ];
                        return (
                            <>
                                {/* Selection border */}
                                <div className="rte-img-overlay" style={{ position: 'absolute', top, left, width: w, height: h, border: '2px solid #3b82f6', pointerEvents: 'none', zIndex: 5 }} />
                                {/* Resize handles */}
                                {handles.map(({ pos, style }) => (
                                    <div
                                        key={pos}
                                        onMouseDown={(e) => handleResizeStart(e, pos)}
                                        className="rte-resize-handle"
                                        style={{ position: 'absolute', width: 8, height: 8, background: '#3b82f6', border: '1px solid white', borderRadius: 1, zIndex: 6, ...style }}
                                    />
                                ))}
                            </>
                        );
                    })()}

                    {/* ═══ Floating Image Toolbar ═══ */}
                    {selectedImage && imageToolbar && (
                        <div
                            className="rte-img-toolbar"
                            style={{
                                position: 'absolute',
                                top: Math.max(0, imageToolbar.top),
                                left: imageToolbar.left,
                                transform: 'translateX(-50%)',
                                zIndex: 10,
                            }}
                        >
                            <div className="flex items-center gap-0.5 bg-white border border-slate-200 rounded-lg shadow-lg px-1.5 py-1 text-[11px]">
                                {/* Alignment */}
                                <button onMouseDown={(e) => { e.preventDefault(); setImageAlignment('inline'); }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-50 text-slate-600" title="Inline">
                                    <MoveHorizontal className="h-3.5 w-3.5" />
                                </button>
                                <button onMouseDown={(e) => { e.preventDefault(); setImageAlignment('left'); }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-50 text-slate-600" title="Float Left">
                                    <AlignLeft className="h-3.5 w-3.5" />
                                </button>
                                <button onMouseDown={(e) => { e.preventDefault(); setImageAlignment('center'); }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-50 text-slate-600" title="Center">
                                    <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
                                </button>
                                <button onMouseDown={(e) => { e.preventDefault(); setImageAlignment('right'); }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-50 text-slate-600" title="Float Right">
                                    <AlignRight className="h-3.5 w-3.5" />
                                </button>

                                <div className="w-px h-5 bg-slate-200 mx-0.5" />

                                {/* Size presets */}
                                <button onMouseDown={(e) => { e.preventDefault(); setImageSize('25%'); }} className="h-6 px-1.5 rounded hover:bg-blue-50 text-slate-600 font-medium" title="25% width">25%</button>
                                <button onMouseDown={(e) => { e.preventDefault(); setImageSize('50%'); }} className="h-6 px-1.5 rounded hover:bg-blue-50 text-slate-600 font-medium" title="50% width">50%</button>
                                <button onMouseDown={(e) => { e.preventDefault(); setImageSize('75%'); }} className="h-6 px-1.5 rounded hover:bg-blue-50 text-slate-600 font-medium" title="75% width">75%</button>
                                <button onMouseDown={(e) => { e.preventDefault(); setImageSize('100%'); }} className="h-6 px-1.5 rounded hover:bg-blue-50 text-slate-600 font-medium" title="Full width">100%</button>

                                <div className="w-px h-5 bg-slate-200 mx-0.5" />

                                {/* Manual size inputs */}
                                <div className="flex items-center gap-1">
                                    <span className="text-slate-400">W</span>
                                    <input
                                        type="number"
                                        value={imageToolbar.width || ''}
                                        onChange={(e) => {
                                            const v = parseInt(e.target.value) || 100;
                                            setImageSize(v + 'px');
                                        }}
                                        className="h-6 w-14 text-[11px] border rounded px-1 text-center"
                                        onMouseDown={(e) => e.stopPropagation()}
                                    />
                                    <span className="text-slate-400">H</span>
                                    <input
                                        type="number"
                                        value={imageToolbar.height || ''}
                                        onChange={(e) => {
                                            const v = parseInt(e.target.value) || 100;
                                            setImageSize(selectedImage.style.width || 'auto', v + 'px');
                                        }}
                                        className="h-6 w-14 text-[11px] border rounded px-1 text-center"
                                        onMouseDown={(e) => e.stopPropagation()}
                                    />
                                </div>

                                <div className="w-px h-5 bg-slate-200 mx-0.5" />

                                {/* Delete */}
                                <button onMouseDown={(e) => { e.preventDefault(); deleteSelectedImage(); }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-red-50 text-red-500" title="Delete Image">
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ═══════════════ STATUS BAR ═══════════════ */}
            {showStatusBar && (
                <div className="bg-slate-50 border-t border-slate-200 px-3 py-1 flex items-center justify-between text-[10px] text-slate-400 no-print">
                    <span>Page: {PAGE_SIZES[pageSize].label} ({PAGE_SIZES[pageSize].width} × {PAGE_SIZES[pageSize].height})</span>
                    <span>Tab = indent • Shift+Tab = outdent • Shift+Enter = line break • Ctrl+A = select all</span>
                </div>
            )}

            {/* ═══════════════ INLINE STYLES ═══════════════ */}
            <style>{`
                .rte-empty[data-placeholder]::before {
                    content: attr(data-placeholder);
                    color: #9ca3af;
                    pointer-events: none;
                    font-style: italic;
                    display: block;
                }
                [contenteditable] {
                    -webkit-user-select: text;
                    -moz-user-select: text;
                    -ms-user-select: text;
                    user-select: text;
                }
                [contenteditable]:focus {
                    outline: none;
                }
                [contenteditable] p {
                    margin: 0 0 6px 0;
                    line-height: inherit;
                }
                [contenteditable] h1, [contenteditable] h2, [contenteditable] h3,
                [contenteditable] h4, [contenteditable] h5, [contenteditable] h6 {
                    margin: 0;
                    line-height: inherit;
                    font-weight: bold;
                    page-break-after: avoid !important;
                }
                [contenteditable] blockquote {
                    border-left: 3px solid #999;
                    padding-left: 12px;
                    margin: 0.5em 0;
                    color: #555;
                }
                [contenteditable] pre {
                    background: #f5f5f5;
                    padding: 12px;
                    border-radius: 4px;
                    font-family: monospace;
                    font-size: 13px;
                    margin: 0.5em 0;
                    overflow-x: auto;
                }
                [contenteditable] table {
                    border-collapse: collapse;
                    width: 100%;
                    margin: 0.5em 0;
                    page-break-inside: avoid !important;
                }
                [contenteditable] td, [contenteditable] th {
                    border: 1px solid #ccc;
                    padding: 6px 10px;
                    min-width: 40px;
                }
                [contenteditable] img {
                    max-width: 100%;
                    height: auto;
                    page-break-inside: avoid !important;
                    cursor: pointer;
                    transition: outline 0.1s;
                }
                [contenteditable] img.rte-img-selected {
                    outline: 2px solid #3b82f6;
                    outline-offset: 2px;
                }
                [contenteditable] img:hover {
                    outline: 1px dashed #93c5fd;
                    outline-offset: 2px;
                }
                .rte-resize-handle {
                    cursor: pointer;
                    transition: background 0.1s;
                }
                .rte-resize-handle:hover {
                    background: #2563eb !important;
                    transform: scale(1.3);
                }
                .rte-img-toolbar {
                    animation: rte-fade-in 0.15s ease;
                }
                @keyframes rte-fade-in {
                    from { opacity: 0; transform: translateX(-50%) translateY(4px); }
                    to { opacity: 1; transform: translateX(-50%) translateY(0); }
                }
                [contenteditable] a {
                    color: inherit;
                    text-decoration: underline;
                }
                [contenteditable] hr {
                    border: none;
                    border-top: 2px solid #333;
                    margin: 16px 0;
                }
                [contenteditable] ul, [contenteditable] ol {
                    padding-left: 24px;
                    margin: 0;
                }
                @media print {
                    .no-print { display: none !important; }
                    .rte-workspace {
                        padding: 0 !important;
                        background: transparent !important;
                        display: block !important;
                        overflow: visible !important;
                    }
                    .rte-sheet {
                        box-shadow: none !important;
                        border: 0 !important;
                        width: 100% !important;
                        margin: 0 !important;
                        min-height: auto !important;
                    }
                    .rte-sheet > div {
                        background-image: none !important;
                        padding: 0 !important; /* Managed by @page margins in container */
                    }
                    /* Allow paragraphs to split naturally to avoid huge gaps */
                    [contenteditable] p, [contenteditable] li {
                        page-break-inside: auto !important;
                    }
                    /* Prevent headers from splitting or being alone at bottom */
                    [contenteditable] h1, [contenteditable] h2, [contenteditable] h3, [contenteditable] h4 {
                        page-break-inside: avoid !important;
                        page-break-after: avoid !important;
                    }
                    .no-print-bg { background: transparent !important; }
                }
            `}</style>
        </div>
    );
};

export default RichTextEditor;
