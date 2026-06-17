"use client";

/**
 * SkillCenter — Skill 管理中心 over the vault's 06 - AI Data/skills/.
 *
 *   Grid view: card wall of skills, filterable by search text + category chip.
 *   Detail view: open a card → read-only SKILL.md; 編輯 button unlocks editing;
 *                a category selector assigns/changes the skill's category.
 *
 * Categories are app-managed (skill-categories.json via /api/skill-categories);
 * editing them never touches the SKILL.md files. SKILL.md content edits are
 * saved whole (no YAML re-serialization).
 */

import { useEffect, useState } from "react";
import { tokenFetch } from "@/lib/security/sidecar-token";

type SkillMeta = {
  slug: string;
  name: string;
  description: string;
  category: string | null;
};

const UNCAT = "未分類";

export function SkillCenter() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState<string | null>(null); // null = all

  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  const refreshList = async (): Promise<SkillMeta[] | undefined> => {
    const r = await tokenFetch("/api/skills");
    if (!r.ok) return;
    const { skills } = (await r.json()) as { skills: SkillMeta[] };
    setSkills(skills);
    return skills;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshList();
      if (!cancelled) setLoadingList(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const open = async (slug: string) => {
    setSelected(slug);
    setLoadingDetail(true);
    setEditing(false);
    setSavedTick(false);
    const r = await tokenFetch(`/api/skills/${slug}`);
    setLoadingDetail(false);
    if (!r.ok) {
      setContent("");
      setOriginal("");
      return;
    }
    const { content } = (await r.json()) as { content: string };
    setContent(content);
    setOriginal(content);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    const r = await tokenFetch(`/api/skills/${selected}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    setSaving(false);
    if (r.ok) {
      setOriginal(content);
      setEditing(false);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2000);
      void refreshList();
    }
  };

  const assignCategory = async (slug: string, category: string | null) => {
    await tokenFetch("/api/skill-categories", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, category }),
    });
    // Optimistic local update + reconcile.
    setSkills((prev) =>
      prev.map((s) => (s.slug === slug ? { ...s, category } : s)),
    );
    void refreshList();
  };

  const categories = Array.from(
    new Set(skills.map((s) => s.category).filter((c): c is string => !!c)),
  ).sort((a, b) => a.localeCompare(b));

  const q = query.trim().toLowerCase();
  const filtered = skills.filter((s) => {
    if (catFilter === UNCAT && s.category) return false;
    if (catFilter && catFilter !== UNCAT && s.category !== catFilter) return false;
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    );
  });

  const current = skills.find((s) => s.slug === selected) ?? null;
  const dirty = content !== original;

  // ── Detail / editor view ───────────────────────────────────────────────
  if (selected) {
    return (
      <main className="flex h-screen flex-1 flex-col overflow-hidden pt-12">
        <div className="flex items-center justify-between gap-4 px-8 pb-4">
          <div className="flex min-w-0 items-center gap-4">
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setEditing(false);
              }}
              className="shrink-0 text-[11px] font-mono uppercase tracking-[0.24em] text-[var(--fg-2)] transition-colors hover:text-[var(--fg-0)]"
            >
              ← 全部
            </button>
            <div className="min-w-0">
              <div className="truncate text-[15px] text-[var(--fg-0)]">
                {current?.name ?? selected}
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-3)]">
                {selected}/SKILL.md
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/* Category selector — immediate save, independent of content edit */}
            <select
              value={current?.category ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__new__") {
                  const name = window.prompt("新分類名稱");
                  if (name && name.trim()) void assignCategory(selected, name.trim());
                  return;
                }
                void assignCategory(selected, v || null);
              }}
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-2)] px-2 py-1.5 text-[11px] text-[var(--fg-1)] outline-none"
            >
              <option value="">未分類</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="__new__">＋ 新分類…</option>
            </select>
            {savedTick && (
              <span className="text-[11px] font-mono text-[var(--accent)]">
                已儲存
              </span>
            )}
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={save}
                  disabled={!dirty || saving}
                  className={`rounded-md border px-4 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] transition-colors ${
                    dirty && !saving
                      ? "border-[var(--accent)] text-[var(--fg-0)] hover:bg-[var(--accent)]/10"
                      : "border-[var(--border-subtle)] text-[var(--fg-3)]"
                  }`}
                >
                  {saving ? "儲存中…" : dirty ? "儲存" : "未變更"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setContent(original);
                    setEditing(false);
                  }}
                  className="rounded-md px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--fg-3)] transition-colors hover:text-[var(--fg-1)]"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-md border border-[var(--border-default)] px-4 py-1.5 text-[11px] font-mono uppercase tracking-[0.2em] text-[var(--fg-1)] transition-colors hover:border-[var(--accent)] hover:text-[var(--fg-0)]"
              >
                編輯
              </button>
            )}
          </div>
        </div>
        {loadingDetail ? (
          <div className="px-8 py-2 text-[12px] font-mono text-[var(--fg-3)]">
            載入中…
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            readOnly={!editing}
            spellCheck={false}
            className={`hub-scrollbar mx-8 mb-8 flex-1 resize-none rounded-lg border p-4 font-mono text-[12.5px] leading-relaxed text-[var(--fg-1)] outline-none ${
              editing
                ? "border-[var(--accent)]/40 bg-black/30 focus:border-[var(--accent)]"
                : "cursor-default border-[var(--border-subtle)] bg-black/20"
            }`}
          />
        )}
      </main>
    );
  }

  // ── Grid view ────────────────────────────────────────────────────────────
  return (
    <main className="flex h-screen flex-1 flex-col overflow-hidden pt-12">
      <div className="px-8 pb-4">
        <div className="mb-3 flex items-center gap-3">
          <span className="text-[10px] font-mono uppercase tracking-[0.32em] text-[var(--accent)]">
            Skill 管理中心
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.32em] text-[var(--fg-3)]">
            {filtered.length}/{skills.length}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋 skill…"
            className="ml-auto w-64 rounded-md border border-[var(--border-subtle)] bg-black/20 px-3 py-1.5 text-[12px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-3)] focus:border-[var(--border-default)]"
          />
        </div>
        {/* Category filter chips */}
        <div className="flex flex-wrap gap-2">
          <Chip active={catFilter === null} onClick={() => setCatFilter(null)}>
            全部
          </Chip>
          {categories.map((c) => (
            <Chip key={c} active={catFilter === c} onClick={() => setCatFilter(c)}>
              {c}
            </Chip>
          ))}
          <Chip active={catFilter === UNCAT} onClick={() => setCatFilter(UNCAT)}>
            {UNCAT}
          </Chip>
        </div>
      </div>

      <div className="hub-scrollbar flex-1 overflow-y-auto px-8 pb-10">
        {loadingList ? (
          <div className="text-[12px] font-mono text-[var(--fg-3)]">載入中…</div>
        ) : filtered.length === 0 ? (
          <div className="text-[12px] font-mono text-[var(--fg-3)]">無符合</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((s) => (
              <button
                key={s.slug}
                type="button"
                onClick={() => open(s.slug)}
                className="group flex flex-col rounded-xl border border-[var(--border-subtle)] bg-black/20 p-4 text-left transition-colors hover:border-[var(--border-default)] hover:bg-white/[0.03]"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-[14px] text-[var(--fg-0)]">
                    {s.name}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-mono uppercase tracking-[0.15em] ${
                      s.category
                        ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                        : "bg-white/[0.05] text-[var(--fg-3)]"
                    }`}
                  >
                    {s.category ?? UNCAT}
                  </span>
                </div>
                <p className="line-clamp-3 text-[11.5px] leading-snug text-[var(--fg-2)]">
                  {s.description || "（無簡介）"}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[11px] transition-colors ${
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--fg-0)]"
          : "border-[var(--border-subtle)] text-[var(--fg-2)] hover:text-[var(--fg-1)]"
      }`}
    >
      {children}
    </button>
  );
}
