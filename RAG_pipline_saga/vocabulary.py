"""
vocabulary.py — the two axes the data does not have yet.

An officer asks "negative posts against BJP about corruption". Nothing in the
record answers either half:

  * ``category`` is a MODERATION taxonomy -- "is this post an offence, under
    which law". It says a post is Abusive. It cannot say the post is about
    corruption, and correctly has no Corruption entry, because corruption is
    not an offence committed by the post.
  * ``stance`` is Support/Oppose toward "the subject the text names" -- but the
    service never records WHAT that subject is. Oppose could mean against the
    police, a policy, a protest or BJP. Unusable alone for "against BJP".

So two new axes, tagged at ingest and filtered exactly:

    topics  = ["corruption", "robbery"]   what the post is about
    targets = ["bjp", "police"]           who the post is about

Populated from curated lists rather than a model, for three reasons: it works
today without re-analysing anything, it is deterministic so an officer can be
told exactly why a post matched, and the model's own category labels have
already proved unreliable on this data (a post criticising one man's behaviour
came back Hate_Speech with BNS 196/299 attached).

Coverage is the honest weakness of lists. These are seeds: add terms as real
questions miss. A missing term means a post is not tagged, which is a false
negative -- visibly wrong and fixable. That is the safer failure direction than
a model quietly mislabelling.

Terms are matched case-insensitively on word boundaries, so "rape" does not
fire on "draped". Romanised Telugu and Hindi are included where a term is
common in this corpus; script forms are matched as substrings because Indic
scripts do not carry ASCII word boundaries.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# topics: what a post is about
# --------------------------------------------------------------------------- #

TOPICS: Dict[str, List[str]] = {
    "corruption": [
        "corruption", "corrupt", "bribe", "bribery", "kickback", "scam", "scandal",
        "graft", "embezzle", "embezzlement", "misappropriation", "black money",
        "money laundering", "lanchan", "lancham", "ghoos", "rishwat",
        "అవినీతి", "లంచం", "भ्रष्टाचार", "रिश्वत",
    ],
    "sexual_violence": [
        "rape", "raped", "gangrape", "gang rape", "sexual assault", "molest",
        "molestation", "molested", "eve teasing", "eve-teasing", "sexual harassment",
        "pocso", "atyachar", "atyachaar",
        "అత్యాచారం", "బలాత్కారం", "बलात्कार", "छेड़छाड़",
    ],
    "robbery": [
        "robbery", "robbed", "theft", "stolen", "burglary", "burgled", "chain snatching",
        "snatching", "looted", "loot", "dacoity", "pickpocket", "chori", "dongatanam",
        "దొంగతనం", "చోరీ", "चोरी", "डकैती",
    ],
    "murder": [
        "murder", "murdered", "killed", "killing", "homicide", "stabbed", "stabbing",
        "lynching", "lynched", "hatya", "khoon",
        "హత్య", "హత్యా", "हत्या",
    ],
    # "hate speech" is deliberately absent. It is a MODERATION label, not a
    # subject: an alert's reasoning says "this post constitutes hate speech"
    # about any post at all, so including it tagged 134 of 238 alerts communal,
    # among them a neutral news item about bus stations. Topic terms must name
    # what a post is ABOUT, never what a classifier decided about it.
    "communal": [
        "communal", "riot", "riots", "hindu muslim", "religious tension", "temple attack",
        "mosque attack", "church attack", "love jihad", "danga", "communal tension",
        "మతపరమైన", "అల్లర్లు", "दंगा", "साम्प्रदायिक",
    ],
    "drugs": [
        "drugs", "drug", "ganja", "narcotics", "cocaine", "heroin", "peddler",
        "peddling", "nashaa", "mdma", "trafficking",
        "గంజాయి", "మాదక", "नशा", "गांजा",
    ],
    "traffic": [
        "traffic", "accident", "rash driving", "drunk driving", "hit and run",
        "road safety", "pothole", "signal jump", "challan", "overspeed",
        "ట్రాఫిక్", "ప్రమాదం", "यातायात", "दुर्घटना",
    ],
    "land": [
        "land grabbing", "land grab", "encroachment", "encroach", "illegal construction",
        "bhoomi", "land mafia", "occupation of land",
        "భూ ఆక్రమణ", "కబ్జా", "भूमि", "कब्जा",
    ],
    "cybercrime": [
        "cyber", "cybercrime", "online fraud", "phishing", "otp fraud", "hacking",
        "hacked", "digital arrest", "sextortion", "fake profile", "cyber crime",
        "సైబర్", "साइबर",
    ],
    "women_safety": [
        "women safety", "woman safety", "she team", "shecteam", "stalking", "stalker",
        "harassment of women", "domestic violence", "dowry",
        "మహిళ", "వేధింపులు", "महिला", "दहेज",
    ],
    "civic": [
        "water supply", "no water", "drainage", "sewage", "garbage", "sanitation",
        "power cut", "electricity", "street light", "civic", "municipal",
        "నీటి", "చెత్త", "పారిశుధ్యం", "बिजली", "पानी",
    ],
    "protest": [
        "protest", "dharna", "bandh", "rally", "agitation", "strike", "morcha",
        "andolan", "hunger strike",
        "ధర్నా", "నిరసన", "धरना", "प्रदर्शन",
    ],
}

# --------------------------------------------------------------------------- #
# targets: who a post is about
#
# A target tag says the post CONCERNS this body. Whether it is for or against
# is `stance`; the two are combined at query time ("against BJP" = target bjp
# AND negative/Oppose). Conflating them here would make a post praising BJP
# indistinguishable from one attacking it.
# --------------------------------------------------------------------------- #

TARGETS: Dict[str, List[str]] = {
    "police": [
        "police", "cop", "cops", "constable", "si ", "circle inspector", "dgp",
        "commissioner", "sho", "acp", "dcp", "cyberabad police", "hyderabad police",
        "telanganadgp", "hydcitypolice", "cyberabadpolice", "rachakondapolice",
        "telanganacops", "hydtp", "khaki", "thana", "station",
        "పోలీస్", "పోలీసు", "पुलिस",
    ],
    "government": [
        "government", "govt", "cm ", "chief minister", "minister", "sarkar",
        "administration", "collector", "mla", "mp ", "municipality", "corporation",
        "telangana government", "state government", "secretariat", "revanth",
        "ప్రభుత్వం", "సర్కార్", "सरकार",
    ],
    "bjp": ["bjp", "bharatiya janata", "bjp4india", "bjp4telangana", "modi",
            "amit shah", "kishan reddy", "బీజేపీ", "भाजपा"],
    "congress": ["congress", "inc ", "rahul gandhi", "revanth reddy", "ttdpcongress",
                 "కాంగ్రెస్", "कांग्रेस"],
    "brs": ["brs", "trs", "kcr", "ktr", "harish rao", "telangana rashtra",
            "బీఆర్ఎస్", "కేసీఆర్"],
    "tdp": ["tdp", "telugu desam", "chandrababu", "lokesh", "టీడీపీ"],
    "ysrcp": ["ysrcp", "ysr congress", "jagan", "వైసీపీ"],
    "mim": ["mim", "aimim", "owaisi", "majlis"],
    "judiciary": ["court", "high court", "supreme court", "judge", "judiciary",
                  "కోర్టు", "अदालत"],
    "media": ["media", "journalist", "press", "news channel", "reporter", "godi media"],
}


def _compile(table: Dict[str, List[str]]) -> List[tuple]:
    """(tag, regex) pairs.

    ASCII terms match on word boundaries so "si " cannot fire inside "inside".
    Indic-script terms match as substrings, because \\b is defined on ASCII word
    characters and never matches between two Telugu letters.
    """
    out = []
    for tag, terms in table.items():
        for term in terms:
            t = term.strip()
            if not t:
                continue
            if re.search(r"[A-Za-z]", t):
                pattern = r"\b" + re.escape(t.strip()) + (r"\b" if not t.endswith(" ") else "")
            else:
                pattern = re.escape(t)
            out.append((tag, re.compile(pattern, re.I)))
    return out


_TOPIC_RX = _compile(TOPICS)
_TARGET_RX = _compile(TARGETS)


def _tags(text: str, compiled: List[tuple]) -> List[str]:
    if not text:
        return []
    found: Set[str] = set()
    for tag, rx in compiled:
        if tag in found:
            continue
        if rx.search(text):
            found.add(tag)
    return sorted(found)


def topics_in(text: str) -> List[str]:
    """Subjects this text is about."""
    return _tags(text, _TOPIC_RX)


def targets_in(text: str) -> List[str]:
    """Bodies this text concerns."""
    return _tags(text, _TARGET_RX)


def tag(text: str) -> Dict[str, List[str]]:
    """Both axes for one piece of text, as facets."""
    out = {}
    topics = topics_in(text)
    targets = targets_in(text)
    if topics:
        out["topics"] = topics
    if targets:
        out["targets"] = targets
    return out


# --------------------------------------------------------------------------- #
# query-side vocabulary
#
# The planner maps the officer's words to the same tags. Kept narrower than the
# ingest lists: a question says "corruption", it does not say "kickback", and a
# loose query map would tag questions that were never about the topic.
# --------------------------------------------------------------------------- #

def query_topic_map() -> Dict[str, str]:
    """Officer vocabulary -> topic tag.

    Multi-word terms are kept: "water supply" and "chain snatching" are exactly
    how these get asked about, and dropping them left "facebook complaints about
    water supply" with no topic at all. Matching is word-boundary anchored in
    the planner, so a phrase only fires when the whole phrase is present.
    """
    words = {}
    for tag_name, terms in TOPICS.items():
        for term in terms:
            t = term.strip().lower()
            if t and re.search(r"[A-Za-z]", t):
                words[t] = tag_name
    # The tag name itself is always a valid query word.
    for tag_name in TOPICS:
        words[tag_name.replace("_", " ")] = tag_name
    # Officers write "posts about protests", not "about protest". Matching is
    # word-boundary anchored, so without the plural the term simply misses and
    # the question falls through to an unknown-concept scan.
    for term, tag_name in list(words.items()):
        if not term.endswith("s"):
            words.setdefault(term + "s", tag_name)
    return words


def query_target_map() -> Dict[str, str]:
    words = {}
    for tag_name, terms in TARGETS.items():
        for term in terms:
            t = term.strip().lower()
            if t and re.search(r"[A-Za-z]", t):
                words[t] = tag_name
    for tag_name in TARGETS:
        words[tag_name] = tag_name
    return words


# --------------------------------------------------------------------------- #
# the multilingual query layer
#
# Everything above is matched with ASCII word boundaries, and the query maps
# dropped any term without a Latin letter. So the ingest side knew "ఫిర్యాదులు"
# and the question side did not: "ఎన్ని ఫిర్యాదులు ఉన్నాయి?" planned a count
# over EVERY record — 7,214 of them — where the English question counted the
# 190 grievances. Same question, same tenant, two different numbers.
#
# The fix is one layer, not a longer regex: terms live in query_vocabulary.json
# and are matched on TOKENS produced by the shared Unicode tokenizer. Token
# matching needs no word boundary, which is what made Indic script unmatchable,
# and it treats every script the same way.
# --------------------------------------------------------------------------- #

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path

# Imported from the submodule directly, not through the package: this module is
# itself imported from inside query_understanding, and going through the package
# attribute would depend on how far its __init__ had got.
from query_understanding.normalize import words as _words

#: Where the query vocabulary lives. Overridable so a deployment can ship its
#: own domain terms without editing code — the seam a generic API needs.
QUERY_VOCABULARY_PATH = os.getenv(
    "AI_QUERY_VOCABULARY",
    str(Path(__file__).resolve().parent / "query_vocabulary.json"))

#: The longest phrase worth testing. "ఎక్కడ ఎక్కువ" is two tokens, "किस जिले"
#: two; four leaves room without turning every question into n-gram soup.
MAX_PHRASE_TOKENS = 4


@lru_cache(maxsize=1)
def query_vocabulary() -> Dict[str, Dict[str, List[str]]]:
    """The query vocabulary, or an empty one if the file is unusable.

    A missing or malformed file must not take the assistant down: the English
    rules still work, so the failure mode is a question in another script that
    falls through to the model — exactly what happened before this layer.
    """
    try:
        with open(QUERY_VOCABULARY_PATH, encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception as exc:                                  # noqa: BLE001
        logger.warning("query vocabulary unavailable at %s: %s",
                       QUERY_VOCABULARY_PATH, exc)
        return {}
    out: Dict[str, Dict[str, List[str]]] = {}
    for section, values in raw.items():
        if section.startswith("_") or not isinstance(values, dict):
            continue
        table = {value: [str(t) for t in terms]
                 for value, terms in values.items()
                 if not value.startswith("_") and isinstance(terms, list)}
        if table:
            out[section] = table
    return out


def _phrases(text: str) -> Set[str]:
    """Every 1..MAX_PHRASE_TOKENS word window in *text*, lowercased.

    Phrases rather than single tokens because "ఎక్కడ ఎక్కువ" means something
    neither word means alone.
    """
    # A trailing apostrophe is punctuation, not part of the word. Without this,
    # "all tenants' data" tokenised to "tenants'" and matched nothing, so the
    # one phrasing an officer would actually type was the one that got through.
    words = []
    for raw in _words(text):
        w = raw.lower().strip("'’-_")
        if w.endswith("'s") or w.endswith("’s"):
            w = w[:-2]
        if w:
            words.append(w)
    out: Set[str] = set()
    for n in range(1, MAX_PHRASE_TOKENS + 1):
        for i in range(len(words) - n + 1):
            out.add(" ".join(words[i:i + n]))
    return out


@lru_cache(maxsize=1)
def _index() -> Dict[str, Dict[str, tuple]]:
    """Per section: exact phrase -> value, and the prefix rules, precompiled."""
    idx: Dict[str, Dict[str, tuple]] = {}
    for section, table in query_vocabulary().items():
        exact: Dict[str, str] = {}
        prefixes: List[tuple] = []
        for value, terms in table.items():
            for term in terms:
                t = (term or "").strip().lower()
                if not t:
                    continue
                if t.endswith("*"):
                    stem = t[:-1].strip()
                    # A one- or two-letter stem would match half the language.
                    if len(stem) >= 3:
                        prefixes.append((stem, value))
                else:
                    exact.setdefault(t, value)
        idx[section] = {"exact": exact, "prefixes": tuple(prefixes)}
    return idx


def matches(section: str, text: str) -> List[str]:
    """Canonical values of *section* that *text* names, best-effort, sorted.

    Returns [] for an unknown section, so a caller may ask for a facet this
    deployment's vocabulary does not define.
    """
    return _match_index(_index().get(section) or {}, text)


#: Precedence, most specific signal first — the same order
#: deterministic.classify_intent applies to English, so a question that is both
#: a comparison and a count is read the same way whichever script it arrives in.
FRAME_PRECEDENCE = ("comparison", "trend", "count", "breakdown", "classify", "situation")


def frame(text: str) -> Optional[str]:
    """Which question frame *text* uses, or None."""
    found = set(matches("frames", text))
    for name in FRAME_PRECEDENCE:
        if name in found:
            return name
    return None


def is_function_word(word: str) -> bool:
    """True when *word* is grammar in one of the configured languages."""
    return word.lower().strip("?.,!") in _function_words()


@lru_cache(maxsize=1)
def _function_words() -> frozenset:
    table = query_vocabulary().get("function_words") or {}
    return frozenset(w.lower() for terms in table.values() for w in terms)


def reload_query_vocabulary() -> None:
    """Drop the cached file. For tests and for a config change without a restart."""
    query_vocabulary.cache_clear()
    _index.cache_clear()
    _function_words.cache_clear()
    query_vocabulary_version.cache_clear()


# --------------------------------------------------------------------------- #
# the ingest tables, asked in any script
#
# `query_topic_map` and `query_target_map` drop every term without a Latin
# letter, because the planner matches them with \b. So the ingest side knew
# "అవినీతి" and a question asking about అవినీతి matched no topic at all. Token
# matching has no such restriction, so those terms are usable on the query side
# too — and only those, because the Latin route already covers the rest and is
# deliberately narrower than the ingest lists.
# --------------------------------------------------------------------------- #

def _non_latin(table: Dict[str, List[str]]) -> Dict[str, List[str]]:
    return {tag: [t for t in terms if t.strip() and not re.search(r"[A-Za-z]", t)]
            for tag, terms in table.items()}


@lru_cache(maxsize=1)
def _script_index() -> Dict[str, Dict[str, tuple]]:
    idx: Dict[str, Dict[str, tuple]] = {}
    for section, table in (("topics", _non_latin(TOPICS)),
                           ("targets", _non_latin(TARGETS))):
        exact = {}
        for tag, terms in table.items():
            for term in terms:
                t = " ".join(w.lower() for w in _words(term))
                if t:
                    exact.setdefault(t, tag)
        idx[section] = {"exact": exact, "prefixes": ()}
    return idx


def _match_index(table: Dict[str, tuple], text: str) -> List[str]:
    if not table or not text:
        return []
    phrases = _phrases(text)
    found = {table["exact"][p] for p in phrases if p in table["exact"]}
    for stem, value in table["prefixes"]:
        if value not in found and any(p.startswith(stem) for p in phrases):
            found.add(value)
    return sorted(found)


def query_topics_in_script(text: str) -> List[str]:
    """Topic tags a non-Latin question names."""
    return _match_index(_script_index()["topics"], text)


def query_targets_in_script(text: str) -> List[str]:
    """Target tags a non-Latin question names."""
    return _match_index(_script_index()["targets"], text)


@lru_cache(maxsize=1)
def query_vocabulary_version() -> str:
    """Identity of the loaded vocabulary: its declared version and its content.

    Cache keys include this. Plans are cached per question, and a question's
    plan depends on the vocabulary that read it — so a vocabulary change with
    an unchanged key would keep serving the plan the OLD terms produced, which
    is the stale-cache failure this layer would otherwise introduce.
    """
    try:
        with open(QUERY_VOCABULARY_PATH, encoding="utf-8") as fh:
            raw = fh.read()
    except Exception:                                         # noqa: BLE001
        return "none"
    declared = "?"
    try:
        declared = str(json.loads(raw).get("version") or "?")
    except Exception:                                         # noqa: BLE001
        pass
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:8]
    return f"{declared}+{digest}"
