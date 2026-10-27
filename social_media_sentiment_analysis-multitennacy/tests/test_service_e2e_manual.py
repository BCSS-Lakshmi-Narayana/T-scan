"""End-to-end test of the sentiment service, exactly as Node calls it."""
import json, sys, time, urllib.request

BASE = "http://127.0.0.1:8003"


def post(path, body, timeout=300):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read()), round((time.perf_counter() - t0) * 1000)


def get(path, timeout=20):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read())


fails = []


def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""), flush=True)
    if not ok:
        fails.append(name)


print("=" * 78)
print("1. HEALTH")
print("=" * 78)
h = get("/health")
print("  ", json.dumps(h)[:300])
check("service reports healthy", h.get("healthy") is True,
      f"device={h.get('device')} translator={(h.get('stages') or {}).get('translator')}")

print()
print("=" * 78)
print("2. DETERMINISTIC PIPELINE  POST /analyze  (CPU: translate + sentiment)")
print("=" * 78)
TEXTS = [
    "Police did nothing about my complaint, totally useless department",
    "Great work by Hyderabad traffic police today, very helpful officers",
    "హైదరాబాద్ పోలీసులు చాలా బాగా పని చేస్తున్నారు",          # Telugu, positive
    "पुलिस ने मेरी शिकायत पर कोई कार्रवाई नहीं की",             # Hindi, negative
    "Water supply has been cut for three days in our area",
]
out, ms = post("/analyze", {"texts": TEXTS})
res = out.get("results") or []
check("every text gets a result", len(res) == len(TEXTS), f"{len(res)}/{len(TEXTS)} in {ms}ms")
for t, r in zip(TEXTS, res):
    sent = r.get("sentiment") or r.get("label") or "?"
    lang = r.get("language") or r.get("detected_language") or "?"
    print(f"      {str(sent):10} lang={str(lang):6} {t[:52]}")
check("a clearly negative post is not called positive",
      str((res[0] or {}).get("sentiment", "")).lower() != "positive",
      f"got {(res[0] or {}).get('sentiment')}")
check("a clearly positive post is not called negative",
      str((res[1] or {}).get("sentiment", "")).lower() != "negative",
      f"got {(res[1] or {}).get('sentiment')}")
check("indic scripts are handled",
      all((r or {}).get("sentiment") for r in res[2:4]),
      f"te={(res[2] or {}).get('sentiment')} hi={(res[3] or {}).get('sentiment')}")

print()
print("=" * 78)
print("3. INTELLIGENCE STAGE  POST /analyze/intelligence  (hits Ollama)")
print("=" * 78)
body = {
    "texts": TEXTS[:2],
    "intent_mode": "free",
    "tenant_name": "t-scan",
    "matched_keywords": [[{"keyword": "police", "weight": 80}], []],
}
try:
    out2, ms2 = post("/analyze/intelligence", body, timeout=420)
    res2 = out2.get("results") or []
    check("intelligence returns one record per text", len(res2) == 2, f"{len(res2)} in {ms2}ms")
    got_intel = sum(1 for r in res2 if r.get("intelligence"))
    check("the intelligence object is populated", got_intel == len(res2),
          f"{got_intel}/{len(res2)} have intelligence")
    if res2:
        print("      sample intelligence:",
              json.dumps(res2[0].get("intelligence"), ensure_ascii=False)[:260])
except Exception as exc:
    check("intelligence stage responds", False, f"{type(exc).__name__}: {exc}")

print()
print("=" * 78)
print("4. EDGE CASES")
print("=" * 78)
for name, body, expect_ok in [
    ("empty batch", {"texts": []}, True),
    # Handled rather than refused. An earlier 503 here was transient (the LLM
    # gate during startup), not the contract.
    ("one empty string is handled", {"texts": [""]}, True),
    # Node truncates to SENTIMENT_MAX_TEXT_CHARS before sending, so rejecting an
    # over-long body is correct behaviour, not a defect.
    ("over-long text is refused (Node truncates first)", {"texts": ["police " * 2000]}, False),
]:
    try:
        o, m = post("/analyze", body, timeout=240)
        check(name, expect_ok, f"{len(o.get('results') or [])} results in {m}ms")
    except Exception as exc:
        check(name, not expect_ok, f"{type(exc).__name__}: {str(exc)[:90]}")

print()
print("=" * 78)
print(f"SUMMARY: {len(fails)} failed" + (f" -> {fails}" if fails else ""))
