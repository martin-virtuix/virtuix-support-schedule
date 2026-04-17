import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Play, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import omniArenaLogo from "@/assets/omniarena-logo.png";
import omniOneLogo from "@/assets/omnione_logo_color.png";
import { cn } from "@/lib/utils";
import {
  getHubVideoLibraryEntries,
  type HubVideoBrand,
  type HubVideoEntry,
} from "@/lib/hubVideos";

type BrandFilter = "all" | HubVideoBrand;

const BRAND_META: Record<HubVideoBrand, { label: string; logo: string; logoClassName: string }> = {
  omni_one: {
    label: "Omni One",
    logo: omniOneLogo,
    logoClassName: "h-4 w-auto",
  },
  omni_arena: {
    label: "Omni Arena",
    logo: omniArenaLogo,
    logoClassName: "h-[14px] w-auto",
  },
};

function videoMatchesQuery(video: HubVideoEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;

  const haystack = [
    video.title,
    video.description ?? "",
    ...(video.tags ?? []),
    BRAND_META[video.brand].label,
    video.sourceLabel,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function BrandPill({
  brand,
  compact = false,
}: {
  brand: HubVideoBrand;
  compact?: boolean;
}) {
  const pillClassName = compact
    ? brand === "omni_arena"
      ? "min-w-[118px] gap-1.5 px-2 py-1"
      : "min-w-[108px] gap-1.5 px-2 py-1"
    : brand === "omni_arena"
      ? "min-w-[132px] gap-2 px-2.5 py-1.5"
      : "min-w-[122px] gap-2 px-2.5 py-1.5";
  const logoShellClassName = compact ? "h-6 px-2" : "h-7 px-2.5";
  const logoClassName = compact
    ? brand === "omni_arena"
      ? "h-[14px] w-auto shrink-0 object-contain"
      : "h-[16px] w-auto shrink-0 object-contain"
    : cn("w-auto shrink-0 object-contain", BRAND_META[brand].logoClassName);
  const labelClassName = compact
    ? "text-[10px] tracking-[0.1em]"
    : "text-[11px] tracking-[0.12em]";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border/80 bg-card/80 shadow-[0_14px_30px_-24px_rgba(15,23,42,0.3)]",
        pillClassName,
      )}
      aria-label={BRAND_META[brand].label}
      title={BRAND_META[brand].label}
    >
      <span className={cn("brand-logo-shell", logoShellClassName)}>
        <img
          src={BRAND_META[brand].logo}
          alt={BRAND_META[brand].label}
          className={logoClassName}
        />
      </span>
      <span className={cn("font-semibold uppercase text-foreground/88", labelClassName)}>{BRAND_META[brand].label}</span>
    </span>
  );
}

function VideoCard({
  video,
  active,
  onSelect,
}: {
  video: HubVideoEntry;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <article
      className={[
        "group surface-panel-soft p-2.5 transition duration-300",
        active
          ? "border-primary/45 bg-primary/[0.11] shadow-[0_20px_40px_-34px_hsl(var(--primary)/0.9)]"
          : "hover:-translate-y-[2px] hover:border-primary/35 hover:bg-muted/35",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onSelect}
        className="w-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <div className="relative overflow-hidden rounded-xl border border-border/75">
          {video.thumbnailUrl ? (
            <img
              src={video.thumbnailUrl}
              alt={`${video.title} thumbnail`}
              loading="lazy"
              className="aspect-video w-full object-cover transition duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-card via-muted/70 to-background dark:from-[#11181f] dark:via-[#0c141a] dark:to-[#081016]">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/35 bg-primary/12 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
                <Play className="h-3.5 w-3.5" />
                Dropbox Video
              </div>
            </div>
          )}
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
          <span className="pointer-events-none absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full border border-white/25 bg-black/45 px-2 py-1 text-[11px] font-medium text-white">
            <Play className="h-3 w-3 fill-white text-white" />
            Watch
          </span>
          {video.featured ? (
            <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
              <Sparkles className="h-3 w-3" />
              Featured
            </span>
          ) : null}
        </div>
      </button>
      <div className="mt-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-semibold leading-5 text-foreground/95 md:text-[14px]">{video.title}</p>
          <BrandPill brand={video.brand} compact />
        </div>
        <Button size="sm" variant="ghost" className="h-8 px-2.5" asChild>
          <a href={video.openUrl} target="_blank" rel="noreferrer">
            {video.sourceLabel}
            <ExternalLink className="ml-2 h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </article>
  );
}

export function VideosPane() {
  const [query, setQuery] = useState("");
  const [brandFilter, setBrandFilter] = useState<BrandFilter>("all");
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);

  const parsedVideos = useMemo(() => getHubVideoLibraryEntries(), []);
  const brandCounts = useMemo(() => {
    const counts: Record<BrandFilter, number> = {
      all: parsedVideos.length,
      omni_one: 0,
      omni_arena: 0,
    };
    parsedVideos.forEach((video) => {
      counts[video.brand] += 1;
    });
    return counts;
  }, [parsedVideos]);

  const filteredVideos = useMemo(() => {
    return parsedVideos.filter((video) => {
      const brandMatches = brandFilter === "all" || video.brand === brandFilter;
      return brandMatches && videoMatchesQuery(video, query);
    });
  }, [brandFilter, parsedVideos, query]);

  useEffect(() => {
    if (filteredVideos.length === 0) {
      setActiveVideoId(null);
      return;
    }

    if (!filteredVideos.some((video) => video.id === activeVideoId)) {
      setActiveVideoId(filteredVideos[0].id);
    }
  }, [activeVideoId, filteredVideos]);

  const activeVideo = filteredVideos.find((video) => video.id === activeVideoId) ?? filteredVideos[0] ?? null;
  const activeVideoPosition = activeVideo ? filteredVideos.findIndex((video) => video.id === activeVideo.id) + 1 : null;
  const upNextVideos = useMemo(() => {
    if (!activeVideo) return filteredVideos.slice(0, 4);
    return filteredVideos.filter((video) => video.id !== activeVideo.id).slice(0, 4);
  }, [activeVideo, filteredVideos]);

  return (
    <section className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="order-1 surface-panel reveal-up reveal-delay-1 relative overflow-hidden p-4 md:p-6 xl:order-2 xl:sticky xl:top-24 xl:self-start">
        <div className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-primary/15 blur-3xl" />
        <div className="pointer-events-none absolute -left-20 bottom-0 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
        {activeVideo ? (
          <div className="relative space-y-4">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Now Playing</p>
              <h3 className="font-display text-xl font-semibold tracking-tight md:text-2xl">{activeVideo.title}</h3>
              <div className="flex flex-wrap items-center gap-2">
                <BrandPill brand={activeVideo.brand} />
                {activeVideo.featured ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary">
                    <Sparkles className="h-3 w-3" />
                    Featured
                  </span>
                ) : null}
                {activeVideoPosition ? (
                  <span className="brand-chip">Video {activeVideoPosition} of {filteredVideos.length}</span>
                ) : null}
              </div>
            </div>

            <div className="table-shell overflow-hidden border-primary/30">
              {activeVideo.playbackType === "embed" && activeVideo.embedUrl ? (
                <iframe
                  src={activeVideo.embedUrl}
                  title={activeVideo.title}
                  className="aspect-video w-full xl:h-[500px] xl:aspect-auto 2xl:h-[580px]"
                  loading="lazy"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              ) : activeVideo.playbackType === "video" && activeVideo.playbackUrl ? (
                <video
                  className="aspect-video w-full bg-black xl:h-[500px] xl:aspect-auto 2xl:h-[580px]"
                  controls
                  preload="metadata"
                >
                  <source src={activeVideo.playbackUrl} type="video/mp4" />
                  Your browser does not support embedded video playback.
                </video>
              ) : (
                <div className="flex aspect-video w-full items-center justify-center px-4 text-center text-sm text-muted-foreground xl:h-[500px] xl:aspect-auto 2xl:h-[580px]">
                  Playback preview is unavailable for this source.
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" asChild>
                <a href={activeVideo.openUrl} target="_blank" rel="noreferrer">
                  Open in {activeVideo.sourceLabel}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </div>

            {upNextVideos.length > 0 ? (
              <div className="space-y-2 border-t border-border/60 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Up Next</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {upNextVideos.map((video) => (
                    <button
                      key={`up-next-${video.id}`}
                      type="button"
                      onClick={() => setActiveVideoId(video.id)}
                      className="surface-panel-soft group flex items-center gap-2.5 p-2 text-left transition duration-300 hover:-translate-y-[1px] hover:border-primary/35 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      {video.thumbnailUrl ? (
                        <img
                          src={video.thumbnailUrl}
                          alt={`${video.title} thumbnail`}
                          loading="lazy"
                          className="h-14 w-24 rounded-md border border-border/70 object-cover transition duration-300 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-md border border-border/70 bg-gradient-to-br from-card via-muted/70 to-background text-[9px] font-semibold uppercase tracking-[0.1em] text-primary dark:from-[#11181f] dark:via-[#0c141a] dark:to-[#081016]">
                          Dropbox
                        </div>
                      )}
                      <div className="min-w-0 space-y-1">
                        <p className="truncate text-[12px] font-semibold">{video.title}</p>
                        <BrandPill brand={video.brand} compact />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-[320px] items-center justify-center text-center text-sm text-muted-foreground">
            Select a video to preview it here.
          </div>
        )}
      </aside>

      <div className="order-2 space-y-4 xl:order-1 xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto xl:pr-1">
        <section className="surface-panel reveal-up reveal-delay-2 relative overflow-hidden p-5 md:p-6">
          <div className="pointer-events-none absolute -right-20 -top-20 h-40 w-40 rounded-full bg-primary/16 blur-3xl" />
          <div className="relative space-y-4">
            <div className="space-y-1.5">
              <h2 className="font-display text-xl font-semibold tracking-tight md:text-2xl">Videos</h2>
            </div>

            <div className="grid gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search by title, topic, or tag"
                  className="h-10 pl-9"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {(["omni_one", "omni_arena"] as const).map((filter) => {
                  const label = BRAND_META[filter].label;
                  const count = brandCounts[filter];
                  return (
                    <Button
                      key={filter}
                      size="sm"
                      variant={brandFilter === filter ? "secondary" : "ghost"}
                      className={[
                        "transition-all duration-200",
                        brandFilter === filter
                          ? "border-primary/40 bg-primary/12 text-primary"
                          : "hover:border-primary/30 hover:bg-muted/45",
                      ].join(" ")}
                      onClick={() => setBrandFilter((current) => (current === filter ? "all" : filter))}
                    >
                      {label}
                      <span className="ml-1.5 rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
                        {count}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {filteredVideos.length === 0 ? (
          <section className="surface-panel-soft p-6 text-sm text-muted-foreground">
            {parsedVideos.length === 0
              ? "No videos yet."
              : "No videos match the current search/filter."}
          </section>
        ) : (
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            {filteredVideos.map((video, index) => (
              <div
                key={video.id}
                className="reveal-up"
                style={{ animationDelay: `${Math.min(index * 35, 280)}ms` }}
              >
                <VideoCard
                  video={video}
                  active={activeVideo?.id === video.id}
                  onSelect={() => setActiveVideoId(video.id)}
                />
              </div>
            ))}
          </section>
        )}
      </div>
    </section>
  );
}
