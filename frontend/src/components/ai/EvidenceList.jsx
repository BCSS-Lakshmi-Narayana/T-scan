/**
 * The evidence behind an answer: one card per post, never one block of text.
 *
 * The backend also flattens these records into the answer string. That copy is
 * stripped before the prose is rendered (see lib/answerText) so the officer
 * sees each record once, as something they can open, rather than twice — once
 * as a wall and once properly.
 *
 * Only a page of cards is mounted at a time. Twenty is enough to scan; the
 * rest are one click away, and the header always states how many matched so
 * the page never implies the set is smaller than it is.
 */

import React, { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import EvidenceCard from './EvidenceCard';
import { evidenceHeading, populationsText, resultCounts } from '../../lib/answerText';
import { Section, Button, EASE } from './ui';

const PAGE = 20;

export default function EvidenceList({ response }) {
    const [shown, setShown] = useState(PAGE);
    const still = useReducedMotion();

    const all = (response?.evidence || []).filter(
        (e) => e && (e.type === 'record' || e.type === 'verdict'));
    if (!all.length) return null;

    const counts = resultCounts(response, shown);
    // Before the deep reading finishes, what is on screen is what retrieval
    // found. Calling it "key evidence" would imply it was chosen because of an
    // analysis that has not happened yet.
    const stage = response?.analysis?.evidence_stage === 'final' ? 'final' : 'initial';
    const visible = all.slice(0, shown);
    const remaining = all.length - visible.length;

    return (
        <Section label={evidenceHeading(stage, counts.analysed)}
            aside={populationsText(counts, stage)} aria-label="Evidence">
            <p className="-mt-1 mb-2.5 text-[12px] text-slate-400 dark:text-slate-500">
                {stage === 'final' && counts.analysed > 0
                    ? 'Representative posts selected from everything that was analysed.'
                    : 'Individual monitored posts supporting this response.'}
            </p>

            <ul className="space-y-2">
                {visible.map((item, i) => (
                    // The list item IS the card: a wrapper div between <ul> and
                    // the card would break the list for a screen reader.
                    <motion.li
                        key={item.id || i}
                        initial={still ? false : { opacity: 0, y: 4 }}
                        animate={still ? {} : { opacity: 1, y: 0 }}
                        // Only the newly revealed page staggers; re-rendering
                        // an open list should not ripple every time.
                        transition={{ duration: 0.18, ease: EASE,
                            delay: still ? 0 : Math.min(i % PAGE, 8) * 0.02 }}
                    >
                        <EvidenceCard item={item} index={i} />
                    </motion.li>
                ))}
            </ul>

            {remaining > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button type="button" onClick={() => setShown((n) => n + PAGE)}>
                        Show {Math.min(PAGE, remaining)} more
                    </Button>
                    <span className="text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                        Showing {visible.length} of {all.length}
                    </span>
                </div>
            )}
        </Section>
    );
}
