"use client";

/**
 * SignalBubbleField — the war-room centerpiece. A force-directed bubble
 * "situational map" of trending AI terms, replacing WorldMonitor's world map.
 *
 *   - bubble size  = term frequency (value, sqrt-scaled for area)
 *   - bubble color = source: IBM (mint) / GitHub (blue) / both (amber)
 *   - bilingual    = Chinese label (large) + English tag (small mono caption)
 *   - hot ring     = a second pulsing ring for terms unusually hot (Z ≥ 1)
 *   - click        = select the term (parent filters the side panels)
 *
 * Visual polish: radial-gradient fills + soft glow filter per source, an
 * animated pulse ring on hot bubbles, and a faint dotted "radar" backdrop so
 * the field reads like an ops console rather than a plain scatter.
 *
 * d3-force runs the packing sim in a useEffect; React owns the SVG render.
 * Positions live in a ref, repainted via rAF so we don't thrash React state.
 */

import { useEffect, useRef, useState } from "react";
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { topicZh } from "@/lib/agent/signals/topic-labels";

export type BubbleDatum = {
  term: string; // canonical English topic id
  value: number; // frequency → radius
  hot: boolean; // Z ≥ 1
  source: "ibm" | "github" | "both";
};

type Node = BubbleDatum & {
  zh: string;
  showZh: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};

const PALETTE: Record<
  BubbleDatum["source"],
  { core: string; edge: string; text: string; sub: string; glow: string }
> = {
  ibm: {
    core: "rgba(0,229,180,0.22)",
    edge: "rgba(0,229,180,0.55)",
    text: "#00e5b4",
    sub: "rgba(0,229,180,0.6)",
    glow: "rgba(0,229,180,0.35)",
  },
  github: {
    core: "rgba(90,160,235,0.22)",
    edge: "rgba(90,160,235,0.55)",
    text: "#9ec5f5",
    sub: "rgba(133,183,235,0.6)",
    glow: "rgba(55,138,221,0.35)",
  },
  both: {
    core: "rgba(255,184,120,0.22)",
    edge: "rgba(255,184,120,0.55)",
    text: "#ffc98c",
    sub: "rgba(255,184,120,0.6)",
    glow: "rgba(255,184,120,0.35)",
  },
};

export function SignalBubbleField({
  data,
  selected,
  onSelect,
  height = 380,
}: {
  data: BubbleDatum[];
  selected: string | null;
  onSelect: (term: string | null) => void;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(700);
  const [, forceRepaint] = useState(0);
  const nodesRef = useRef<Node[]>([]);
  const simRef = useRef<Simulation<Node, undefined> | null>(null);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const update = () => {
      const w = node.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (data.length === 0) {
      nodesRef.current = [];
      forceRepaint((n) => n + 1);
      return;
    }
    const maxVal = Math.max(...data.map((d) => d.value), 1);
    const minR = 32;
    const maxR = Math.min(76, Math.max(48, height / 4.4));
    const radius = (v: number) => minR + (maxR - minR) * Math.sqrt(v / maxVal);

    const cx = width / 2;
    const cy = height / 2;
    const nodes: Node[] = data.map((d, i) => {
      const zh = topicZh(d.term);
      return {
        ...d,
        zh,
        showZh: zh !== d.term, // false → only English available
        r: radius(d.value),
        x: cx + Math.cos(i * 1.7) * 50,
        y: cy + Math.sin(i * 1.7) * 50,
        vx: 0,
        vy: 0,
      };
    });
    nodesRef.current = nodes;

    simRef.current?.stop();
    const sim = forceSimulation<Node>(nodes)
      .force("charge", forceManyBody().strength(6))
      .force("center", forceCenter(cx, cy))
      .force("x", forceX(cx).strength(0.035))
      .force("y", forceY(cy).strength(0.06))
      .force(
        "collide",
        forceCollide<Node>()
          .radius((d) => d.r + 6)
          .strength(0.92),
      )
      .alpha(1)
      .alphaDecay(0.04);

    let raf = 0;
    const paint = () => {
      forceRepaint((n) => n + 1);
      if (sim.alpha() > 0.008) raf = requestAnimationFrame(paint);
    };
    sim.on("tick", () => {
      for (const n of nodes) {
        n.x = Math.max(n.r + 2, Math.min(width - n.r - 2, n.x));
        n.y = Math.max(n.r + 2, Math.min(height - n.r - 2, n.y));
      }
    });
    raf = requestAnimationFrame(paint);
    simRef.current = sim;
    return () => {
      cancelAnimationFrame(raf);
      sim.stop();
    };
  }, [data, width, height]);

  const nodes = nodesRef.current;

  return (
    <div ref={wrapRef} style={{ width: "100%", position: "relative" }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="AI 訊號熱詞氣泡圖"
        style={{ display: "block" }}
      >
        <defs>
          {(["ibm", "github", "both"] as const).map((s) => (
            <radialGradient
              key={s}
              id={`bub-${s}`}
              cx="38%"
              cy="34%"
              r="72%"
            >
              <stop offset="0%" stopColor={PALETTE[s].core} />
              <stop offset="100%" stopColor="rgba(0,0,0,0.06)" />
            </radialGradient>
          ))}
          {(["ibm", "github", "both"] as const).map((s) => (
            <filter
              key={s}
              id={`glow-${s}`}
              x="-40%"
              y="-40%"
              width="180%"
              height="180%"
            >
              <feDropShadow
                dx="0"
                dy="0"
                stdDeviation="6"
                floodColor={PALETTE[s].glow}
              />
            </filter>
          ))}
        </defs>

        {/* faint radar grid backdrop */}
        <g opacity={0.5} pointerEvents="none">
          {[0.32, 0.62, 0.92].map((f) => (
            <circle
              key={f}
              cx={width / 2}
              cy={height / 2}
              r={(Math.min(width, height) / 2) * f}
              fill="none"
              stroke="var(--fg-3, #545a6b)"
              strokeOpacity={0.12}
              strokeDasharray="2 5"
            />
          ))}
        </g>

        {nodes.map((n) => {
          const p = PALETTE[n.source];
          const isSel = selected === n.term;
          const dim = selected != null && !isSel;
          const zhSize = Math.max(12, Math.min(17, n.r / 3));
          const enSize = Math.max(9, Math.min(11.5, n.r / 4.4));
          return (
            <g
              key={n.term}
              transform={`translate(${n.x},${n.y})`}
              style={{
                cursor: "pointer",
                opacity: dim ? 0.28 : 1,
                transition: "opacity 220ms",
              }}
              onClick={() => onSelect(isSel ? null : n.term)}
            >
              {/* hot pulse ring */}
              {n.hot && !dim ? (
                <circle r={n.r + 5} fill="none" stroke={p.edge} strokeWidth={1}>
                  <animate
                    attributeName="r"
                    values={`${n.r + 2};${n.r + 11};${n.r + 2}`}
                    dur="2.6s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.55;0;0.55"
                    dur="2.6s"
                    repeatCount="indefinite"
                  />
                </circle>
              ) : null}

              <circle
                r={n.r}
                fill={`url(#bub-${n.source})`}
                stroke={isSel ? p.text : p.edge}
                strokeWidth={isSel ? 2.2 : 1.2}
                filter={isSel ? `url(#glow-${n.source})` : undefined}
              />

              {/* Chinese label (or English if no zh) */}
              <text
                textAnchor="middle"
                dy={n.showZh ? "-0.12em" : "0.18em"}
                fontSize={zhSize}
                fill={p.text}
                fontFamily="var(--font-sans, sans-serif)"
                fontWeight={500}
                style={{ pointerEvents: "none" }}
              >
                {n.zh.length > 9 ? n.zh.slice(0, 8) + "…" : n.zh}
              </text>
              {/* English tag caption (only when a Chinese label exists) */}
              {n.showZh ? (
                <text
                  textAnchor="middle"
                  dy="1.0em"
                  fontSize={enSize}
                  fill={p.sub}
                  fontFamily="var(--font-mono, monospace)"
                  style={{ pointerEvents: "none" }}
                >
                  {n.term.length > 18 ? n.term.slice(0, 17) + "…" : n.term}
                </text>
              ) : null}
              {/* frequency pill */}
              <text
                textAnchor="middle"
                dy={n.showZh ? "2.3em" : "1.55em"}
                fontSize={9.5}
                fill={n.hot ? p.text : "var(--fg-2, #8a91a4)"}
                fontFamily="var(--font-mono, monospace)"
                style={{ pointerEvents: "none" }}
              >
                ×{n.value}
                {n.hot ? " ↑" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
