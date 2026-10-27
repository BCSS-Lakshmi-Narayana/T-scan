/**
 * Whether a scrolling conversation should follow new content.
 *
 * A chat that always jumps to the bottom is fine while nothing changes on its
 * own. This one changes on its own: the deep analysis polls every couple of
 * seconds and rewrites the answer in place, so an unconditional "scroll to
 * bottom" pulled the officer back down every few seconds and made the evidence
 * above impossible to read.
 *
 * The rule is the one every chat client uses: follow new content only if the
 * reader was already at the bottom. Scroll up and you are left alone; scroll
 * back down and following resumes.
 */

/**
 * How close to the bottom still counts as "at the bottom".
 *
 * Generous enough to survive a half-rendered image or a line of text arriving,
 * small enough that a reader who has deliberately scrolled up is never
 * mistaken for one who has not.
 */
export const STICK_THRESHOLD_PX = 120;

/**
 * True when `el` is scrolled to (or near) its bottom.
 *
 * Takes anything with the three numbers, so it can be reasoned about and
 * tested without a DOM. A missing element counts as stuck: at first render
 * there is nothing to scroll and the next turn should be visible.
 */
export function isAtBottom(el, threshold = STICK_THRESHOLD_PX) {
    if (!el) return true;
    const { scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = el;
    // Content shorter than the viewport cannot be scrolled away from.
    if (scrollHeight <= clientHeight) return true;
    return scrollHeight - scrollTop - clientHeight <= threshold;
}
