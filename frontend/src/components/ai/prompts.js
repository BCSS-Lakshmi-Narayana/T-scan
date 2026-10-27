/**
 * Static content for the assistant: starter questions, follow-up suggestions
 * and the retrieval window options.
 *
 * Kept out of the page so the catalogue can be edited without reading through
 * chat state and request handling.
 *
 * There is no seeded greeting message. A chat that opens by talking about
 * itself costs the officer a screen before they have asked anything; the empty
 * state introduces the tool and then gets out of the way.
 */

import { Activity, ShieldAlert, Scale, TrendingUp } from 'lucide-react';

export const TIME_WINDOW_OPTIONS = [
  { label: '24h', title: 'Last 24 hours', value: 1 },
  { label: '7d', title: 'Last 7 days', value: 7 },
  { label: '30d', title: 'Last 30 days', value: 30 },
  { label: 'All', title: 'All time', value: 0 },
];

/**
 * Starter questions, in the shapes officers actually ask.
 *
 * Every one is taken from the validated query set, so each is known to route
 * correctly — a starter that returns nothing teaches the officer the tool does
 * not work. English leads, because that is what officers type; the Romanised
 * Telugu examples stay as live regression cases for mixed-script support.
 *
 * `lead` is the question the tile offers first. The rest sit under it.
 */
export const PROMPT_CATEGORIES = [
  {
    title: 'Recent activity',
    tone: 'blue',
    icon: Activity,
    blurb: 'What is happening now',
    lead: "What's happening in Hyderabad recently?",
    prompts: [
      "What's happening in Hyderabad recently?",
      'Show me women safety related activity in Hyderabad.',
      'Hyderabad lo em jarugutundi?',
    ],
  },
  {
    title: 'High-risk activity',
    tone: 'rose',
    icon: ShieldAlert,
    blurb: 'What needs attention',
    lead: 'Show me recent high risk activity in Hyderabad.',
    prompts: [
      'Show me recent high risk activity in Hyderabad.',
      'How many high risk posts are there in Hyderabad?',
      'How many high risk posts were there in Hyderabad this week?',
    ],
  },
  {
    title: 'Compare locations',
    tone: 'violet',
    icon: Scale,
    blurb: 'Two places, one measure',
    lead: 'Compare Hyderabad and Mulugu for high risk content.',
    prompts: [
      'Compare Hyderabad and Mulugu for high risk content.',
      'Which has more high risk posts, Hyderabad or Mulugu?',
      'Women safety related posts ekkuva ekkada unnayi?',
    ],
  },
  {
    title: 'Trends',
    tone: 'amber',
    icon: TrendingUp,
    blurb: 'What is moving',
    lead: 'How has high risk activity in Hyderabad changed recently?',
    prompts: [
      'How has high risk activity in Hyderabad changed recently?',
      'Show me the trend of women safety related posts in Hyderabad.',
      'Compare this week with last week for Hyderabad.',
    ],
  },
];

/**
 * A single tint per category, used only for the tile's icon.
 *
 * Colour identifies the kind of question at a glance and does nothing else —
 * no gradient borders, no glow, no coloured card. The tile stays neutral so
 * four of them side by side read as one set rather than four alerts.
 */
export const TONE = {
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300',
  rose: 'bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-300',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-300',
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300',
  slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

/**
 * Follow-up suggestions offered under an answer.
 *
 * These are questions the assistant is known to answer, phrased the way the
 * validated set phrases them. Suggesting something that routes badly is worse
 * than suggesting nothing: the officer reads the failure as the tool's limit.
 */
export const followupsFor = (text) => {
  const t = (text || '').toLowerCase();
  const set = new Set();

  if (/\brisk|alert|serious|critical\b/.test(t)) {
    set.add('How has this changed recently?');
    set.add('Where is it getting more attention?');
  }
  if (/\bwomen safety|grievance|complaint|protest|murder\b/.test(t)) {
    set.add('Where is it getting more attention?');
    set.add('Show me the most recent posts about this.');
  }
  if (/\bcompare|vs\b|than\b/.test(t)) {
    set.add('How has high risk activity changed recently?');
  }
  if (/\btrend|changed|increase|decrease|week\b/.test(t)) {
    set.add('Compare this week with last week.');
  }
  if (set.size === 0) {
    set.add('Recent?');
    set.add('Where is it getting more attention?');
  }
  return Array.from(set).slice(0, 3);
};
