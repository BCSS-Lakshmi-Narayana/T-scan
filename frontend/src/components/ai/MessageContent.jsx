/**
 * The assistant answers in a small, predictable subset of Markdown: headings,
 * bullets, numbered steps, bold, inline code and links. A full Markdown parser
 * would bring a dependency and a sanitiser for three constructs we control, so
 * this renders that subset directly.
 *
 * Nothing here interpolates HTML, so a model answer cannot inject markup.
 */

import React from 'react';
import { ExternalLink } from 'lucide-react';

const INLINE_RE =
  /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]+?)(?=[).,!?;:'"\s]|$))/;

/** Bold / code / links inside one line. */
export function renderInline(text, isUser = false) {
    if (!text) return null;
    const tokens = [];
    let rest = String(text);
    let key = 0;

    while (rest) {
        const m = rest.match(INLINE_RE);
        if (!m) {
            tokens.push(<span key={key++}>{rest}</span>);
            break;
        }
        if (m.index > 0) tokens.push(<span key={key++}>{rest.slice(0, m.index)}</span>);

        if (m[2] != null) {
            tokens.push(
                <strong key={key++} className={isUser ? 'font-semibold text-white' : 'font-semibold text-slate-900 dark:text-white'}>
                    {m[2]}
                </strong>
            );
        } else if (m[3] != null) {
            tokens.push(
                <code key={key++} className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[12px] dark:bg-slate-700/80">
                    {m[3]}
                </code>
            );
        } else if (m[4] != null) {
            tokens.push(<Link key={key++} href={m[5]} label={m[4]} />);
        } else if (m[6] != null) {
            const url = m[6];
            const short = url.replace(/^https?:\/\//, '').slice(0, 55) + (url.length > 60 ? '…' : '');
            tokens.push(<Link key={key++} href={url} label={short} />);
        }
        rest = rest.slice(m.index + m[0].length);
    }
    return tokens;
}

/** Every citation is a real link out to the post; make that obvious and clickable. */
const Link = ({ href, label }) => (
    <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 break-all font-medium text-blue-600 underline-offset-2 transition-colors hover:underline dark:text-blue-400"
    >
        {label}
        <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
);

/** Block-level structure: headings, bullets, numbered steps, paragraphs. */
export default function MessageContent({ content, isUser = false }) {
    if (!content) return null;

    const blocks = [];
    let key = 0;

    for (const line of String(content).split('\n')) {
        const t = line.trim();

        if (!t) {
            blocks.push(<div key={key++} className="h-2" />);
            continue;
        }

        if (/^#{2,3}\s+/.test(t)) {
            blocks.push(
                <p key={key++} className={`mb-1 mt-3 text-sm font-semibold first:mt-0 ${isUser ? 'text-white' : 'text-slate-800 dark:text-slate-100'}`}>
                    {renderInline(t.replace(/^#{2,3}\s+/, ''), isUser)}
                </p>
            );
        } else if (/^[•\-*]\s+/.test(t)) {
            blocks.push(
                <div key={key++} className="flex items-start gap-2">
                    <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${isUser ? 'bg-blue-200' : 'bg-slate-400 dark:bg-slate-500'}`} />
                    <span className="flex-1 text-sm leading-relaxed">{renderInline(t.replace(/^[•\-*]\s+/, ''), isUser)}</span>
                </div>
            );
        } else if (/^\d+\.\s+/.test(t)) {
            const num = t.match(/^(\d+)\./)[1];
            blocks.push(
                <div key={key++} className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 text-xs font-bold tabular-nums ${isUser ? 'text-blue-200' : 'text-slate-500 dark:text-slate-400'}`}>
                        {num}.
                    </span>
                    <span className="flex-1 text-sm leading-relaxed">{renderInline(t.replace(/^\d+\.\s+/, ''), isUser)}</span>
                </div>
            );
        } else {
            blocks.push(
                <p key={key++} className="text-sm leading-relaxed">{renderInline(t, isUser)}</p>
            );
        }
    }

    return <div className="space-y-1">{blocks}</div>;
}
