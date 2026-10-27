import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { Plus, Minus, Maximize2 } from 'lucide-react';

/* ──────────────────────────────────────────────────────────────────────────
 * DistrictMap — dependency-free, pannable / zoomable SVG choropleth.
 *
 * Hand-rolled rather than pulling in Leaflet or d3-geo: we draw one state's
 * ~3.5k points, so a full mapping stack would ship hundreds of kilobytes to do
 * less than this file does.
 *
 * Interaction
 *   • drag to pan, wheel to zoom about the cursor, ± / reset controls,
 *     double-click to zoom in, pinch on touch.
 *   • selecting a district pans and zooms to it, framed so neighbouring
 *     districts stay visible for context. The move is a plain camera
 *     transform — geography is never distorted, because a choropleth whose
 *     shapes have been warped no longer tells the truth about the ground it
 *     depicts. Emphasis comes from colour, stroke weight and elevation.
 *
 * Colour
 *   • Three ordered, named bands — High / Medium / Low — matching the scale
 *     used by every tile and panel on the board. The legend names them and the
 *     tooltip gives each level's count, so colour never carries meaning alone.
 *   • "No data" is a distinct neutral, never the low end of the scale, so an
 *     unmonitored district is never misread as a calm one.
 * ────────────────────────────────────────────────────────────────────────── */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The same three levels, colours and words used everywhere else on the board.
// A district is coloured by the band it is actually in — not by thresholding a
// derived percentage, which is what made the map disagree with every panel
// beside it.
const BANDS = [
  { key: 'high', label: 'High', light: '#d03b3b', dark: '#d03b3b' },
  { key: 'medium', label: 'Medium', light: '#fab219', dark: '#fab219' },
  { key: 'low', label: 'Low', light: '#0ca30c', dark: '#0ca30c' }
];
const BAND_BY_KEY = Object.fromEntries(BANDS.map((b) => [b.key, b]));

// Four ordered steps for negative-post volume, scaled relative to the worst
// district: green (fewest) → yellow → orange → red (most). These are the same
// four status colours the tiles and panels use, so the map reads on the board's
// existing scale rather than introducing another one.
const RAMP = ['#0ca30c', '#fab219', '#ec835a', '#d03b3b'];
const RAMP_LABELS = ['Few', 'Some', 'Many', 'Most'];
const rampColor = (t) => RAMP[clamp(Math.round(t * (RAMP.length - 1)), 0, RAMP.length - 1)];

// Distinctly neutral, and dark enough to read as a filled shape against the
// panel rather than disappearing into it.
const NO_DATA = { light: '#e3e8ee', dark: '#212b38' };


const MIN_K = 0.8;
const MAX_K = 14;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const DistrictMap = ({
  features = [],
  bbox,
  values = {},
  // Names what the colours represent, for the accessible label only —
  // the banding itself comes from each district's own `band`.
  measure = 'risk',
  isDark = false,
  height = 420,
  onSelect,
  selected = null
}) => {
  const [hover, setHover] = useState(null);
  const [tip, setTip] = useState({ x: 0, y: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);

  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const pinchRef = useRef(null);
  const rafRef = useRef(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const W = 1000;
  const H = 620;

  /* ── Projection ──────────────────────────────────────────────────────── */
  const project = useMemo(() => {
    if (!bbox) return null;
    const [minX, minY, maxX, maxY] = bbox;
    const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
    const kx = Math.cos(midLat);
    const spanX = (maxX - minX) * kx;
    const spanY = maxY - minY;
    if (spanX <= 0 || spanY <= 0) return null;
    const pad = 0.05;
    const scale = Math.min((W * (1 - pad * 2)) / spanX, (H * (1 - pad * 2)) / spanY);
    const offX = (W - spanX * scale) / 2;
    const offY = (H - spanY * scale) / 2;
    return ([lng, lat]) => [offX + (lng - minX) * kx * scale, offY + (maxY - lat) * scale];
  }, [bbox]);

  // Project once; pan/zoom is a group transform, so this never recomputes.
  const shapes = useMemo(() => {
    if (!project) return [];
    return features.map((f) => {
      const rings = f.polygons.map((ring) => ring.map(project));
      let cx = 0; let cy = 0; let n = 0;
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      rings.forEach((r) => r.forEach(([x, y]) => {
        cx += x; cy += y; n += 1;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }));
      return {
        district: f.district,
        rings,
        centroid: [cx / n, cy / n],
        box: [x0, y0, x1, y1],
        radius: Math.max(x1 - x0, y1 - y0) / 2
      };
    });
  }, [features, project]);

  const focus = useMemo(
    () => shapes.find((s) => s.district === selected) || null,
    [shapes, selected]
  );

  const paths = useMemo(
    () => shapes.map((s) => ({
      district: s.district,
      d: s.rings.map((ring) => {
        let out = '';
        for (let i = 0; i < ring.length; i += 1) {
          out += `${i === 0 ? 'M' : 'L'}${ring[i][0].toFixed(1)},${ring[i][1].toFixed(1)}`;
        }
        return `${out}Z`;
      }).join(' ')
    })),
    [shapes]
  );

  /* ── Animation ───────────────────────────────────────────────────────── */
  const animateTo = useCallback((target) => {
    cancelAnimationFrame(rafRef.current);
    if (prefersReducedMotion()) { setView(target); return; }
    const from = { ...viewRef.current };
    const t0 = performance.now();
    const DUR = 460;
    const ease = (t) => 1 - (1 - t) ** 3;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / DUR);
      const e = ease(p);
      setView({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k + (target.k - from.k) * e
      });
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // Selecting a district pans and zooms to it — a plain, undistorted camera
  // move. Geography stays true; the selection is called out by colour, weight
  // and elevation instead. It is framed to about a third of the viewport so
  // neighbouring districts stay visible for context.
  useEffect(() => {
    if (!shapes.length) return;
    if (!focus) { animateTo({ x: 0, y: 0, k: 1 }); return; }
    const [x0, y0, x1, y1] = focus.box;
    const bw = Math.max(x1 - x0, 1);
    const bh = Math.max(y1 - y0, 1);
    const k = clamp(Math.min((W * 0.34) / bw, (H * 0.34) / bh), 1, 3.2);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    animateTo({ x: W / 2 - cx * k, y: H / 2 - cy * k, k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, shapes.length]);

  /* ── Pan / zoom ──────────────────────────────────────────────────────── */
  const toLocal = (clientX, clientY) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return [0, 0];
    return [((clientX - r.left) / r.width) * W, ((clientY - r.top) / r.height) * H];
  };

  const zoomAbout = useCallback((factor, px, py) => {
    cancelAnimationFrame(rafRef.current);
    setView((v) => {
      const k = clamp(v.k * factor, MIN_K, MAX_K);
      const real = k / v.k;
      return { k, x: px - (px - v.x) * real, y: py - (py - v.y) * real };
    });
  }, []);

  // Non-passive so the page doesn't scroll while zooming the map.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const [px, py] = toLocal(e.clientX, e.clientY);
      zoomAbout(e.deltaY < 0 ? 1.18 : 1 / 1.18, px, py);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAbout]);

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top });

    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;   // tolerate click jitter
    d.moved = true;
    setDragging(true);
    cancelAnimationFrame(rafRef.current);
    const box = svgRef.current?.getBoundingClientRect();
    const sx = box ? W / box.width : 1;
    const sy = box ? H / box.height : 1;
    setView((v) => ({ ...v, x: d.ox + dx * sx, y: d.oy + dy * sy }));
  };

  const endDrag = (e) => {
    // releasePointerCapture throws if this pointer was never captured (e.g. the
    // pointer left the SVG without a drag ever starting), so check first.
    try {
      if (e?.currentTarget?.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch (_) { /* non-fatal */ }
    const moved = dragRef.current?.moved;
    dragRef.current = null;
    setDragging(false);
    return moved;
  };

  // Two-finger pinch.
  const touchState = useRef(null);
  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      touchState.current = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
      dragRef.current = null;
    }
  };
  const onTouchMove = (e) => {
    if (e.touches.length === 2 && touchState.current) {
      e.preventDefault();
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const [px, py] = toLocal((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      zoomAbout(dist / touchState.current.d, px, py);
      touchState.current.d = dist;
    }
  };
  const onTouchEnd = () => { touchState.current = null; };

  const reset = () => { onSelect?.(null); animateTo({ x: 0, y: 0, k: 1 }, 0); };

  /* ── Fill ────────────────────────────────────────────────────────────── */
  // A district supplies either a named band (high | medium | low) or an
  // `intensity` in 0..1 for the comparative ramp. Neither ⇒ no data.
  const fillFor = useCallback((district) => {
    const v = values[district];
    if (!v) return isDark ? NO_DATA.dark : NO_DATA.light;
    if (typeof v.intensity === 'number') return rampColor(v.intensity);
    const b = BAND_BY_KEY[v.band];
    return b ? b[isDark ? 'dark' : 'light'] : (isDark ? NO_DATA.dark : NO_DATA.light);
  }, [values, isDark]);

  if (!project || !paths.length) {
    return (
      <div className="grid place-items-center text-[12px] text-slate-400 dark:text-slate-500" style={{ minHeight: height }}>
        Boundary data unavailable
      </div>
    );
  }

  const hoverData = hover ? values[hover] : null;
  const stroke = isDark ? '#0b1220' : '#ffffff';
  const btn = 'h-7 w-7 grid place-items-center rounded-lg bg-white/95 dark:bg-slate-800/95 ring-1 ring-slate-900/10 dark:ring-white/10 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white shadow-sm transition disabled:opacity-40';

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden rounded-xl bg-slate-50/60 dark:bg-slate-950/40"
      style={{ height }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-full block touch-none"
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        role="img"
        aria-label={`District map coloured by ${measure} risk level`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={(e) => { endDrag(e); setHover(null); }}
        onPointerCancel={endDrag}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onDoubleClick={(e) => { const [px, py] = toLocal(e.clientX, e.clientY); zoomAbout(1.6, px, py); }}
      >
        <defs>
          <filter id="dm-lift" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor={isDark ? '#000' : '#0f172a'} floodOpacity={isDark ? 0.55 : 0.22} />
          </filter>
        </defs>

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {paths.map((p) => {
            const isSel = selected === p.district;
            const isHover = hover === p.district;
            if (isSel) return null;            // drawn last, on top
            return (
              <path
                key={p.district}
                d={p.d}
                fill={fillFor(p.district)}
                stroke={isHover ? (isDark ? '#e2e8f0' : '#0f172a') : stroke}
                strokeWidth={isHover ? 1.8 : 1}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className={onSelect ? 'cursor-pointer' : ''}
                // Unselected districts recede but stay legible — a faded-out map
                // is as unhelpful as a distorted one.
                style={{ opacity: focus ? 0.78 : 1, transition: 'opacity .25s ease' }}
                onPointerEnter={() => !dragging && setHover(p.district)}
                onPointerLeave={() => setHover(null)}
                onClick={() => { if (!dragRef.current?.moved) onSelect?.(p.district === selected ? null : p.district); }}
              >
                <title>{`${p.district}: ${values[p.district]?.label ?? 'no data'}`}</title>
              </path>
            );
          })}

          {/* Selection drawn last so it sits above its neighbours */}
          {paths.filter((p) => p.district === selected).map((p) => (
            <path
              key={p.district}
              d={p.d}
              fill={fillFor(p.district)}
              stroke={isDark ? '#f8fafc' : '#0f172a'}
              strokeWidth={2.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              filter="url(#dm-lift)"
              className="cursor-pointer"
              onPointerEnter={() => !dragging && setHover(p.district)}
              onPointerLeave={() => setHover(null)}
              onClick={() => { if (!dragRef.current?.moved) onSelect?.(null); }}
            >
              <title>{`${p.district}: ${values[p.district]?.label ?? 'no data'}`}</title>
            </path>
          ))}
        </g>
      </svg>

      {/* Controls */}
      <div className="absolute top-2.5 right-2.5 flex flex-col gap-1.5">
        <button className={btn} onClick={() => zoomAbout(1.35, W / 2, H / 2)} disabled={view.k >= MAX_K} aria-label="Zoom in" title="Zoom in">
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
        <button className={btn} onClick={() => zoomAbout(1 / 1.35, W / 2, H / 2)} disabled={view.k <= MIN_K} aria-label="Zoom out" title="Zoom out">
          <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
        <button className={btn} onClick={reset} aria-label="Reset view" title="Reset view">
          <Maximize2 className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
      </div>

      {(view.k > 1.02 || selected) && (
        <div className="absolute bottom-2.5 left-2.5 rounded-md bg-white/90 dark:bg-slate-800/90 ring-1 ring-slate-900/10 dark:ring-white/10 px-2 py-0.5 text-[10px] font-medium tabular-nums text-slate-500 dark:text-slate-400">
          {view.k.toFixed(1)}×{selected ? ` · ${selected}` : ''}
        </div>
      )}

      {hover && !dragging && (
        <div
          className="pointer-events-none absolute z-20 rounded-lg bg-white dark:bg-slate-800 ring-1 ring-slate-900/10 dark:ring-white/15 shadow-lg px-3 py-2 min-w-[152px]"
          style={{
            left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth || 400) - 176),
            top: Math.max(Math.min(tip.y - 10, (wrapRef.current?.clientHeight || 300) - 130), 4)
          }}
        >
          <div className="text-[12.5px] font-semibold text-slate-900 dark:text-white">{hover}</div>
          {hoverData ? (
            <>
              <div className="text-[11px] font-medium mt-0.5" style={{ color: fillFor(hover) }}>{hoverData.label}</div>
              {hoverData.rows?.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-700 space-y-0.5">
                  {hoverData.rows.map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4 text-[11px]">
                      <span className="text-slate-500 dark:text-slate-400">{k}</span>
                      <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">No data collected</div>
          )}
        </div>
      )}
    </div>
  );
};

const NoDataKey = ({ isDark }) => (
  <span className="inline-flex items-center gap-1" title="No posts have been analysed in this district yet">
    <span className="h-2.5 w-2.5 rounded-[2px] ring-1 ring-slate-300 dark:ring-slate-600"
      style={{ background: isDark ? NO_DATA.dark : NO_DATA.light }} />
    Not analysed yet
  </span>
);

/**
 * `scale` switches the legend to the diverging sentiment scale. A colour scale
 * is meaningless without its anchors, so both poles AND the midpoint are
 * labelled with the actual values, and the measure is spelled out — a reader
 * should not have to guess what "net sentiment" is counting.
 */
// Plain colour key: one swatch, one word. Anything more belongs in the tooltip,
// which already gives each district's exact counts on hover.
const SENTIMENT_KEY = RAMP.map((c, i) => ({ c, label: `${RAMP_LABELS[i]} negative` }));

export const MapLegend = ({ isDark = false, scale = null }) => (
  <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap text-[10.5px] text-slate-500 dark:text-slate-400">
    {(scale ? SENTIMENT_KEY : BANDS.map((b) => ({ c: isDark ? b.dark : b.light, label: `${b.label} risk` }))).map((k) => (
      <span key={k.label} className="inline-flex items-center gap-1">
        <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: k.c }} />
        {k.label}
      </span>
    ))}
    <NoDataKey isDark={isDark} />
  </div>
);

export { BANDS };
export default DistrictMap;
