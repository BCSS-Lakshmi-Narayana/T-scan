"""
normalize.py — tidy the question without destroying it.

Normalisation exists so downstream regexes see predictable text, not so the
user's words can be rewritten. The raw query is always preserved on the plan;
this produces a parallel string, never a replacement.

Deliberately conservative. Case is preserved for Indic scripts and for handles
(@TelanganaDGP is not @telanganadgp to a reader), smart quotes and dashes are
folded because they break literal matching, and whitespace is collapsed.
Nothing is translated, nothing is stemmed, nothing is dropped.
"""

from __future__ import annotations

import re
from typing import List

import regex
import unicodedata

_SMART = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
}
_ZERO_WIDTH = re.compile(r"[​-‍﻿]")
_WS = re.compile(r"\s+")
# Keep ? and ! — they carry question shape. Strip trailing noise only.
_TRAILING = re.compile(r"[\s,;:.]+$")


def normalize(query: str) -> str:
    """A cleaned parallel form of *query*, safe for rule matching."""
    if not query:
        return ""
    text = unicodedata.normalize("NFC", query)
    for bad, good in _SMART.items():
        text = text.replace(bad, good)
    text = _ZERO_WIDTH.sub("", text)
    text = _WS.sub(" ", text).strip()
    return _TRAILING.sub("", text)


def is_nonsense(normalized: str) -> bool:
    """True for input with no linguistic content worth planning against.

    "xyzabc123" must not become a concept. The test is deliberately narrow:
    a single token, no spaces, and either no letters at all or a letter/digit
    mash with no vowel-bearing script. Anything a person might have meant
    survives and is planned normally.
    """
    text = (normalized or "").strip()
    if not text:
        return True
    if " " in text:
        return False
    if len(text) > 30:
        return True
    # Any Indic script token is real input, however short.
    if any(ord(ch) > 0x0900 for ch in text):
        return False
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return True
    has_digits = any(c.isdigit() for c in text)
    vowels = sum(1 for c in text.lower() if c in "aeiou")
    return has_digits and vowels <= 1


# --------------------------------------------------------------------------- #
# word boundaries that hold for every script the officers actually type
# --------------------------------------------------------------------------- #

# Python's `re` has no \p{M}, and its \w EXCLUDES the combining marks that
# carry vowels and the virama in Indic scripts. So `[^\W\d_]+` split "ఎన్ని"
# into ['ఎన', 'న'] — the virama and both vowel signs discarded — and the same
# for Devanagari. Every layer that counted or matched words then read a Telugu
# question as a handful of meaningless fragments.
#
# A word is therefore: a letter, the marks that belong to it, then more of the
# same, with the joiners a word can legitimately contain. The `regex` module is
# used because it implements the Unicode property classes this needs; it is a
# direct dependency of the same environment.
_WORD_RE = regex.compile(
    r"\p{L}\p{M}*(?:[\p{L}\p{M}\p{Nd}]|[-_'’‌‍])*",
    regex.UNICODE)


def words(text: str) -> List[str]:
    """Every word in `text`, in order, for any script.

    Letters keep the marks attached to them, so an Indic word survives as one
    token instead of one token per consonant.
    """
    return _WORD_RE.findall(text or "")


def word_count(text: str) -> int:
    """How many words `text` holds — script-independent."""
    return len(words(text))
