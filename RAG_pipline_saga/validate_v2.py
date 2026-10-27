"""
validate_v2.py — run the v2 golden set and score it against the acceptance
criteria, using an ORACLE that does not share code with the retriever.

    python validate_v2.py                 # writes reports/v2_validation.json

What each metric means here, honestly:

  analytics exactness      every aggregate / trend / comparison number the
                           pipeline produced, recomputed by v2fixture.oracle_docs
                           (independent filter logic) over the same corpus.
  tool selection           compiled tool set == the case's expected set.
  citations                every [E#] in the answer exists in the evidence, and
                           every cited record exists in the corpus.
  unsupported claims       numbers in the final answer that no evidence holds.
  tenant / district leak   every cited record belongs to the caller's tenant and
                           visible districts (checked against the corpus).
  unauthorised execution   an executed step whose tool the gate did not allow.
  scope escalation         execution districts wider than the caller's scope.
  Recall@20, precision     scored against the fixture's ground-truth themes with
                           the SCRIPTED judge — they prove the pipeline plumbs
                           recall and verdicts correctly, NOT production quality.
                           Production recall/precision need a labelled real set
                           and the rebuilt vector layer (Phase 0F-B, blocked).

Everything runs in-process over the fixture: no database, no GPU, no model.
"""

from __future__ import annotations

import json
import logging
import os
import re
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional

os.environ.setdefault("RERANKER_ENABLED", "false")   # never load a GPU model here

import conversation as conv
import v2fixture as fx
from orchestrator import pipeline, respond
from orchestrator.models import Evidence
from orchestrator.tools import TIMEOUTS
from policy import RequestContext
from runtime import cache as cache_mod
from runtime.router import Router
from runtime.telemetry import METRICS

HERE = os.path.dirname(os.path.abspath(__file__))
GOLDEN = os.path.join(HERE, "orchestrator", "golden_v2.json")
_CITE = re.compile(r"\[(E\d+)\]")


def _ctx(preset: dict, user: str = "golden-user") -> RequestContext:
    return RequestContext(tenant_id=preset["tenant_id"], user_id=user, role=preset["role"],
                          districts=preset["districts"], permissions=frozenset(preset["permissions"]))


def _p(s: Optional[str]):
    return datetime.fromisoformat(s) if s else None


def _oracle_count(corpus, tenant, visible, place, spec, since=None, until=None, side_place=None):
    docs = fx.oracle_docs(corpus, tenant, visible,
                          since=since if since is not None else _p(spec.get("since")),
                          until=until if until is not None else _p(spec.get("until")),
                          kinds=spec.get("kinds") or (), sentiment=spec.get("sentiment"),
                          risk_levels=spec.get("risk_levels") or (),
                          platforms=spec.get("platforms") or (), topics=spec.get("topics") or ())
    for p in (place, side_place):
        if p:
            docs = [d for d in docs if set(d["metadata"].get("districts") or []) & set(p)]
    return docs


def check_analytics(corpus, ctx, internal) -> List[dict]:
    """[{kind, expected, got, ok}] for every number the pipeline produced."""
    out = []
    ep = internal.get("execution_plan") or {}
    steps = {s["step_id"]: s for s in ep.get("steps", [])}
    visible = ep.get("execution_districts")
    place = ep.get("place_districts")
    for ev in internal.get("evidence", []):
        step = steps.get(ev["step_id"])
        if not step:
            continue
        spec = step["arguments"].get("spec", {})
        f = ev["facts"]
        tool = ev["tool"]
        if ev["source_type"] == "aggregate" and "total" in f and tool in ("aggregate", "hybrid_search",
                                                                         "lookup_records"):
            exp = len(_oracle_count(corpus, ctx.tenant_id, visible, place, spec))
            out.append({"kind": f"{tool}.total", "expected": exp, "got": f["total"],
                        "ok": exp == f["total"]})
        elif ev["source_type"] == "aggregate" and "rows" in f and tool == "aggregate":
            docs = _oracle_count(corpus, ctx.tenant_id, visible, place, spec)
            by = f["group_by"]
            counts: Dict[str, int] = defaultdict(int)
            for d in docs:
                m = d["metadata"]
                if by == "published_at":
                    continue
                v = m.get(by)
                for x in (v if isinstance(v, list) else [v]):
                    if x not in (None, ""):
                        counts[x] += 1
            if by == "published_at":
                continue
            ok = all(counts.get(r["value"]) == r["count"] for r in f["rows"])
            top_ok = sorted(counts.values(), reverse=True)[:len(f["rows"])] == \
                sorted((r["count"] for r in f["rows"]), reverse=True)
            out.append({"kind": f"aggregate.by_{by}", "expected": dict(counts),
                        "got": {r["value"]: r["count"] for r in f["rows"]}, "ok": ok and top_ok})
        elif ev["source_type"] == "trend":
            cw, pw = f.get("current_window"), f.get("previous_window")
            cur = len(_oracle_count(corpus, ctx.tenant_id, visible, place, spec, _p(cw[0]), _p(cw[1])))
            prev = len(_oracle_count(corpus, ctx.tenant_id, visible, place, spec, _p(pw[0]), _p(pw[1])))
            pct = round((cur - prev) / prev * 100, 1) if prev else None
            out.append({"kind": "trend", "expected": [cur, prev, pct],
                        "got": [f["current"], f["previous"], f["change_pct"]],
                        "ok": [cur, prev, pct] == [f["current"], f["previous"], f["change_pct"]]})
        elif ev["source_type"] == "comparison":
            sides = step["arguments"]["sides"]
            exp = []
            for side in sides:
                sp = side.get("districts")
                if sp is not None and visible is not None:
                    sp = [d for d in visible if d in sp]
                exp.append(len(_oracle_count(corpus, ctx.tenant_id, visible, None, spec,
                                             _p(side.get("since")) or _p(spec.get("since")),
                                             _p(side.get("until")) or _p(spec.get("until")),
                                             side_place=sp)))
            got = [s["count"] for s in f["sides"]]
            out.append({"kind": "comparison", "expected": exp, "got": got, "ok": exp == got})
    return out


def run(verbose: bool = False) -> dict:
    logging.disable(logging.WARNING)
    golden = json.load(open(GOLDEN, encoding="utf-8"))
    corpus = fx.build()
    results, metrics = [], defaultdict(list)
    stage_lat: Dict[str, List[float]] = defaultdict(list)
    class_lat: Dict[str, List[float]] = defaultdict(list)
    METRICS.reset()
    cache_mod.PLANS.clear()
    cache_mod.RETRIEVAL.clear()

    for case in golden["cases"]:
        Router.breakers.clear()
        ctxs = golden["contexts"]
        ctx = _ctx(ctxs[case["context"]])
        then = _ctx(ctxs[case.get("then_context", case["context"])])
        llm = fx.scripted_llm(fail=case.get("llm_fail", False), synth=case.get("synth"),
                              plan_reply=case.get("plan_reply"))
        inject = case.get("inject")
        saved = dict(TIMEOUTS)
        if inject == "slow":
            from orchestrator import tools as tm
            tm.TIMEOUTS.update({k: 0.3 for k in tm.HANDLERS})
            tm.DEFAULT_TIMEOUT_SAVED = tm.DEFAULT_TIMEOUT
            tm.DEFAULT_TIMEOUT = 0.3
        deps = pipeline.Deps(
            store=conv.InMemoryConversationStore(),
            backend_factory=fx.backend_factory(corpus, fail=inject if inject != "slow" else None,
                                               slow=1.0 if inject == "slow" else 0.0),
            raw_generate=llm, planner_llm=case.get("planner_llm", False),
            synthesize=case.get("synthesize", False), cache=False)
        cid, res, err = None, None, None
        t0 = time.perf_counter()
        try:
            for i, q in enumerate(case["turns"]):
                c = then if i == len(case["turns"]) - 1 else ctx
                res = pipeline.run(q, c, deps, conversation_id=cid, now=fx.NOW,
                                   requested_tenant_id=case.get("requested_tenant_id"))
                cid = res.conversation_id
        except Exception as exc:          # a crash is a failed case, not a skipped one
            err = f"{type(exc).__name__}: {exc}"
        finally:
            if inject == "slow":
                from orchestrator import tools as tm
                tm.TIMEOUTS.clear()
                tm.TIMEOUTS.update(saved)
                tm.DEFAULT_TIMEOUT = tm.DEFAULT_TIMEOUT_SAVED
        elapsed = (time.perf_counter() - t0) * 1000

        r = {"id": case["id"], "category": case["category"], "error": err}
        if res is None:
            r["passed"] = False
            results.append(r)
            continue
        resp, internal = res.response, res.internal
        final_ctx = then
        r["status"] = resp.status
        r["status_ok"] = resp.status in case["status"]
        ep = internal.get("execution_plan") or {}
        compiled = sorted({s["tool"] for s in ep.get("steps", [])
                           if not s["step_id"].startswith("refine")})
        if "tools" in case:
            r["tools_expected"], r["tools_got"] = sorted(case["tools"]), compiled
            r["tools_ok"] = sorted(case["tools"]) == compiled
            metrics["tool_selection"].append(r["tools_ok"])

        # -- evidence integrity --------------------------------------------
        evidence = [Evidence.model_validate(e) for e in internal.get("evidence", [])]
        ev_ids = {e.evidence_id for e in evidence}
        cited = set(_CITE.findall(resp.answer + " " + (resp.interpretation or "")))
        citations_ok = cited <= ev_ids and {c.evidence_id for c in resp.citations} <= ev_ids
        invented, tenant_leak, district_leak = 0, 0, 0
        visible = final_ctx.districts
        for e in evidence:
            if e.source_type not in ("record", "verdict") or not e.source_id:
                continue
            doc = fx.doc_for_key(corpus, e.source_id)
            if doc is None:
                invented += 1
                continue
            m = doc["metadata"]
            if m["tenant_id"] != final_ctx.tenant_id:
                tenant_leak += 1
            ds = m.get("districts") or []
            if visible is not None and ds and not set(ds) & set(visible):
                district_leak += 1
        _, unsupported = respond.check_claims(resp.answer, evidence, case["turns"][-1])
        if resp.interpretation:
            _, u2 = respond.check_claims(resp.interpretation, evidence, case["turns"][-1])
            unsupported += u2
        r.update(citations_ok=citations_ok and invented == 0, invented_records=invented,
                 tenant_leak=tenant_leak, district_leak=district_leak,
                 unsupported_claims=unsupported, claims_removed=resp.unsupported_claims_removed)
        metrics["citations"].append(r["citations_ok"])
        metrics["unsupported"].append(unsupported)
        metrics["tenant_leak"].append(tenant_leak)
        metrics["district_leak"].append(district_leak)

        # -- authority ------------------------------------------------------
        pol = internal.get("policy") or {}
        allowed = set(pol.get("allowed_capabilities") or [])
        executed = [s["tool"] for s in ep.get("steps", [])
                    if (internal.get("step_results") or {}).get(s["step_id"])]
        unauthorised = [t for t in executed if t not in allowed]
        eff, exe = pol.get("effective_districts"), ep.get("execution_districts")
        escalation = bool(ep) and eff is not None and (exe is None or not set(exe) <= set(eff))
        r.update(unauthorised_tools=unauthorised, scope_escalation=escalation,
                 refinements=internal.get("refinements", 0))
        metrics["unauthorised"].append(len(unauthorised))
        metrics["escalation"].append(int(escalation))
        metrics["refinements"].append(internal.get("refinements", 0))

        # -- analytics ---------------------------------------------------------
        checks = check_analytics(corpus, final_ctx, internal)
        r["analytics"] = checks
        metrics["analytics"].extend(c["ok"] for c in checks)

        # -- recall / precision on ground truth (scripted judge) ---------------
        if "relevant" in case and ep.get("steps"):
            spec = ep["steps"][0]["arguments"].get("spec", {})
            rel = {d["metadata"]["document_id"] for d in
                   _oracle_count(corpus, final_ctx.tenant_id, ep.get("execution_districts"),
                                 ep.get("place_districts"), {**spec, "topics": [],
                                                            "kinds": spec.get("kinds")})
                   if corpus["truth"][d["metadata"]["document_id"]] == case["relevant"]}
            got = []
            for e in evidence:
                if e.source_type in ("record", "verdict") and e.source_id:
                    doc = fx.doc_for_key(corpus, e.source_id)
                    if doc and doc["metadata"]["document_id"] not in got:
                        got.append(doc["metadata"]["document_id"])
            got = got[:20]
            recall = (len(set(got) & rel) / min(len(rel), 20)) if rel else None
            r["recall@20"] = recall
            if recall is not None:
                metrics["recall"].append(recall)
        if case.get("classify"):
            tp = fp = 0
            for e in evidence:
                if e.source_type == "verdict" and e.facts.get("labels"):
                    doc = fx.doc_for_key(corpus, e.source_id)
                    truth = corpus["truth"][doc["metadata"]["document_id"]]
                    if any(fx._theme_of(l) == truth for l in e.facts["labels"]):
                        tp += 1
                    else:
                        fp += 1
            if tp + fp:
                r["precision"] = tp / (tp + fp)
                metrics["precision"].append(r["precision"])

        for s in res.trace.get("spans", []):
            stage_lat[s["stage"]].append(s["ms"])
        class_lat[case["category"]].append(elapsed)
        r["passed"] = bool(r["status_ok"] and r.get("tools_ok", True) and r["citations_ok"]
                           and not unsupported and not tenant_leak and not district_leak
                           and not unauthorised and not escalation and r["refinements"] <= 2
                           and all(c["ok"] for c in checks) and err is None)
        results.append(r)
        if verbose:
            print(f"{'PASS' if r['passed'] else 'FAIL'} {case['id']:30} {resp.status:14} "
                  f"tools={compiled} analytics={sum(c['ok'] for c in checks)}/{len(checks)}")

    def pct(vals, p):
        if not vals:
            return None
        s = sorted(vals)
        return round(s[min(len(s) - 1, int(p * (len(s) - 1) + 0.5))], 3)

    def rate(xs):
        return round(sum(1 for x in xs if x) / len(xs), 4) if xs else None

    summary = {
        "cases": len(results), "passed": sum(1 for r in results if r["passed"]),
        "tool_selection_accuracy": rate(metrics["tool_selection"]),
        "tool_selection_n": len(metrics["tool_selection"]),
        "analytics_exactness": rate(metrics["analytics"]), "analytics_checks": len(metrics["analytics"]),
        "citation_correctness": rate(metrics["citations"]),
        "unsupported_claims": sum(metrics["unsupported"]),
        "tenant_leakage": sum(metrics["tenant_leak"]),
        "district_leakage": sum(metrics["district_leak"]),
        "unauthorised_tool_executions": sum(metrics["unauthorised"]),
        "scope_escalations": sum(metrics["escalation"]),
        "max_refinements": max(metrics["refinements"] or [0]),
        "fixture_recall_at_20": round(statistics.mean(metrics["recall"]), 4) if metrics["recall"] else None,
        "fixture_recall_n": len(metrics["recall"]),
        "fixture_classification_precision": round(statistics.mean(metrics["precision"]), 4)
        if metrics["precision"] else None,
        "latency_ms_by_stage": {k: {"n": len(v), "p50": pct(v, .5), "p95": pct(v, .95),
                                    "p99": pct(v, .99)} for k, v in sorted(stage_lat.items())},
        "latency_ms_by_class": {k: {"n": len(v), "p50": pct(v, .5), "p95": pct(v, .95),
                                    "p99": pct(v, .99)} for k, v in sorted(class_lat.items())},
    }
    return {"summary": summary, "results": results}


if __name__ == "__main__":
    out = run(verbose=True)
    os.makedirs(os.path.join(HERE, "reports"), exist_ok=True)
    path = os.path.join(HERE, "reports", "v2_validation.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, default=str, ensure_ascii=False)
    print(json.dumps({k: v for k, v in out["summary"].items() if not k.startswith("latency")},
                     indent=1))
    print("written", path)
    sys.exit(0 if out["summary"]["passed"] == out["summary"]["cases"] else 1)
