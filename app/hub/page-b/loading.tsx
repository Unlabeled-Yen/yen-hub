/**
 * /hub/page-b loading state.
 *
 * Without this, Next App Router blocks on the server-side
 * `await generateCoachCard()` in page.tsx — clicks on the Duffy badge
 * feel frozen mid-transition for several seconds while the LLM call
 * (or cache hit) resolves. Adding loading.tsx swaps to this skeleton
 * immediately so the navigation feels instant.
 *
 * Mirrors page.tsx's outer shell (same header + section spine) so the
 * skeleton → page transition is just "content fills in", not a layout
 * jump.
 */

export default function PageBLoading() {
  return (
    <div className="min-h-screen px-8 sm:px-12 py-14">
      {/* Header — exact same dimensions as page.tsx */}
      <header className="mb-20 flex items-end justify-between">
        <div>
          <h1
            className="text-[120px] leading-[0.85] tracking-tight text-[var(--fg-0)] select-none"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Duffy
          </h1>
          <p className="mt-4 text-[11px] font-mono tracking-[0.32em] uppercase text-[var(--fg-2)]">
            正在喚醒⋯
          </p>
        </div>
        <span className="text-[10px] font-mono tracking-[0.24em] uppercase text-[var(--fg-3)]">
          ← home
        </span>
      </header>

      <main>
        {/* Sensor strip skeleton */}
        <div className="mb-10 h-[44px] rounded border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.015)]" />

        {/* Tier 1: 今日 + 待辦 並排 */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-8 gap-y-10 mb-14">
          <SkeletonSection num="01" name="今日" height={260} colSpan={8} />
          <SkeletonSection num="02" name="待辦" height={260} colSpan={4} />
        </div>

        {/* Tier 2: 排程（緊湊） */}
        <div className="mb-14">
          <SkeletonSection num="03" name="排程" height={90} colSpan={12} />
        </div>

        {/* Tier 2.5: 信任分層 */}
        <div className="mb-14">
          <SkeletonSection num="04" name="信任分層" height={110} colSpan={12} />
        </div>

        {/* Tier 3: 記憶 */}
        <SkeletonSection num="05" name="記憶" height={360} colSpan={12} />
      </main>
    </div>
  );
}

function SkeletonSection({
  num,
  name,
  height,
  colSpan,
}: {
  num: string;
  name: string;
  height: number;
  colSpan: 4 | 5 | 7 | 8 | 12;
}) {
  const span =
    colSpan === 12
      ? "lg:col-span-12"
      : colSpan === 8
        ? "lg:col-span-8"
        : colSpan === 7
          ? "lg:col-span-7"
          : colSpan === 5
            ? "lg:col-span-5"
            : "lg:col-span-4";
  return (
    <section className={span}>
      <div className="flex items-baseline gap-3 mb-5">
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--accent)] opacity-50">
          {num}
        </span>
        <span className="text-[10px] font-mono tracking-[0.32em] uppercase text-[var(--fg-3)]">
          {name}
        </span>
        <div className="flex-1 h-px bg-[var(--fg-3)] opacity-20" />
      </div>
      <div
        className="rounded-lg border border-[var(--border-subtle)] bg-[rgba(255,255,255,0.02)] animate-pulse"
        style={{ height }}
      />
    </section>
  );
}
