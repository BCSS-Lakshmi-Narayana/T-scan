"""
reranker.py — reading the question and the post together.

A bi-encoder (the embedding model) scores the question and the post
separately and compares two vectors; it is fast and loose. A cross-encoder
reads both in one pass and scores how well the post answers the question. It
is far more accurate, and far cheaper than the LLM, so it sits between them:
recall hands it ~200 candidates, it keeps the best, and only those reach the
judge.

BAAI/bge-reranker-v2-m3 is multilingual (Telugu, Hindi, English), ~570M
parameters, ~1.1 GB in fp16. Loaded lazily on first use. Unavailable (not
downloaded, no GPU memory, RERANKER_ENABLED=false) means pass-through: the
candidates keep their recall order and the judge still decides. Degrades,
never fails.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import List, Optional

logger = logging.getLogger(__name__)

RERANKER_MODEL = os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
RERANKER_ENABLED = os.getenv("RERANKER_ENABLED", "true").lower() in ("1", "true", "yes", "on")
RERANKER_DEVICE = os.getenv("RERANKER_DEVICE", "")          # "" = cuda if available
RERANKER_BATCH = int(os.getenv("RERANKER_BATCH", "32"))
RERANKER_MAX_LEN = int(os.getenv("RERANKER_MAX_LENGTH", "512"))

_state = {"model": None, "tokenizer": None, "device": None, "failed": False}
_lock = threading.Lock()


def _load() -> bool:
    if _state["model"] is not None:
        return True
    if _state["failed"] or not RERANKER_ENABLED:
        return False
    with _lock:
        if _state["model"] is not None:
            return True
        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            device = RERANKER_DEVICE or ("cuda" if torch.cuda.is_available() else "cpu")
            tok = AutoTokenizer.from_pretrained(RERANKER_MODEL)
            model = AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL)
            if device.startswith("cuda"):
                model = model.half()
            model.to(device).eval()
            _state.update(model=model, tokenizer=tok, device=device)
            logger.info("Reranker loaded: %s on %s", RERANKER_MODEL, device)
            return True
        except Exception as exc:
            # Remembered, so a missing model costs one log line, not a load
            # attempt on every question.
            _state["failed"] = True
            logger.warning("Reranker unavailable (%s); continuing without it.", exc)
            return False


def available() -> bool:
    return _load()


def score(query: str, texts: List[str]) -> Optional[List[float]]:
    """Relevance of each text to *query*, higher is better; None when the
    reranker is unavailable, so callers keep their existing order."""
    if not texts or not _load():
        return None
    import torch

    model, tok, device = _state["model"], _state["tokenizer"], _state["device"]
    out: List[float] = []
    try:
        with torch.no_grad():
            for i in range(0, len(texts), RERANKER_BATCH):
                batch = texts[i:i + RERANKER_BATCH]
                enc = tok([[query, t or ""] for t in batch], padding=True, truncation=True,
                          max_length=RERANKER_MAX_LEN, return_tensors="pt").to(device)
                logits = model(**enc).logits.view(-1).float()
                out.extend(logits.cpu().tolist())
        return out
    except Exception as exc:
        logger.warning("Rerank failed, keeping recall order: %s", exc)
        return None
