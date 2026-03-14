export type HubVideoBrand = "omni_one" | "omni_arena";
export type HubVideoSource = "youtube" | "dropbox";
export type HubVideoPlaybackType = "embed" | "video" | "external";

export type HubVideoItem = {
  id: string;
  title: string;
  url: string;
  brand: HubVideoBrand;
  source?: HubVideoSource;
  description?: string;
  tags?: string[];
  featured?: boolean;
};

export type HubVideoEntry = HubVideoItem & {
  source: HubVideoSource;
  sourceLabel: "YouTube" | "Dropbox";
  openUrl: string;
  playbackType: HubVideoPlaybackType;
  playbackUrl: string | null;
  embedUrl: string | null;
  thumbnailUrl: string | null;
};

export const HUB_VIDEO_LIBRARY: HubVideoItem[] = [
  {
    id: "replace-omni-agg-board",
    title: "How to Replace Omni AGG Board",
    url: "https://youtu.be/M1QHrAI8nzQ",
    brand: "omni_arena",
    tags: ["replacement", "hardware", "agg-board"],
    featured: true,
  },
  {
    id: "replace-side-exterior-tv",
    title: "How to Replace a Side Exterior TV",
    url: "https://youtu.be/fY3DuJx2LoI",
    brand: "omni_arena",
    tags: ["replacement", "hardware", "tv"],
  },
  {
    id: "replace-front-exterior-tv",
    title: "How to Replace a Front Exterior TV",
    url: "https://youtu.be/DMZBNjQrcgk",
    brand: "omni_arena",
    tags: ["replacement", "hardware", "tv"],
  },
  {
    id: "replace-internal-he-cable",
    title: "How to Replace an Internal HE Cable",
    url: "https://youtu.be/YO-ovka3AZ8",
    brand: "omni_arena",
    tags: ["replacement", "hardware", "cable"],
  },
  {
    id: "replace-pc",
    title: "How to Replace a PC",
    url: "https://youtu.be/8zlhuQLIt2k",
    brand: "omni_arena",
    tags: ["replacement", "hardware", "pc"],
  },
  {
    id: "replace-omni-ring-handle",
    title: "How to Replace an Omni Ring Handle",
    url: "https://youtu.be/F3w_JydU47o",
    brand: "omni_arena",
    tags: ["replacement", "hardware", "ring-handle"],
  },
  {
    id: "omni-one-walking-tutorial",
    title: "Omni One - Walking Tutorial",
    url: "https://www.youtube.com/watch?v=4oMuVxaH5NM",
    brand: "omni_one",
    tags: ["omni-one", "tutorial", "movement"],
    featured: true,
  },
  {
    id: "prepare-omni-one-arm-shipping",
    title: "How to Prepare your Omni One Arm for Shipping",
    url: "https://www.youtube.com/shorts/Xy96H1dRLYU",
    brand: "omni_one",
    tags: ["omni-one", "shipping", "arm"],
  },
  {
    id: "assemble-omni-one",
    title: "How to Assemble your Omni One",
    url: "https://www.youtube.com/watch?v=s6-BI1HkKpM",
    brand: "omni_one",
    tags: ["omni-one", "assembly", "setup"],
  },
  {
    id: "pair-omni-one-foot-trackers",
    title: "How to Pair the Omni One Foot Trackers",
    url: "https://www.youtube.com/watch?v=P6u1_4mgldw",
    brand: "omni_one",
    tags: ["omni-one", "trackers", "pairing"],
  },
  {
    id: "adjust-omni-one",
    title: "How to Adjust your Omni One",
    url: "https://www.youtube.com/watch?v=7PFN8-gFrfo",
    brand: "omni_one",
    tags: ["omni-one", "adjustment", "fit"],
  },
  {
    id: "strafe-in-omni-one",
    title: "How to Strafe in Omni One",
    url: "https://www.youtube.com/watch?v=og3NRkubsfY",
    brand: "omni_one",
    tags: ["omni-one", "movement", "strafe"],
  },
  {
    id: "height-latch-adjustment-part-1",
    title: "How to Adjust the Height Latch Mechanism - Part 1",
    url: "https://www.dropbox.com/s/dzypltag1l4f1q9/Height%20Lock%20Adjustment%20Video%201.mp4?dl=0",
    source: "dropbox",
    brand: "omni_arena",
    tags: ["omni-one", "height-latch", "adjustment"],
    featured: true,
  },
  {
    id: "height-latch-adjustment-part-2",
    title: "How to Adjust the Height Latch Mechanism - Part 2",
    url: "https://www.dropbox.com/s/x36gf59rg6yal2d/Height%20Lock%20Adjustment%20Video%202.mp4?dl=0",
    source: "dropbox",
    brand: "omni_arena",
    tags: ["omni-one", "height-latch", "adjustment"],
  },
];

const SUPPORTED_YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const SUPPORTED_DROPBOX_HOSTS = new Set([
  "dropbox.com",
  "www.dropbox.com",
]);

function normalizeUrl(rawValue: string): URL | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function isValidYouTubeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

export function extractYouTubeVideoId(rawValue: string): string | null {
  const parsed = normalizeUrl(rawValue);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  if (!SUPPORTED_YOUTUBE_HOSTS.has(host)) {
    return null;
  }

  if (host.includes("youtu.be")) {
    const candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return isValidYouTubeId(candidate) ? candidate : null;
  }

  const watchId = parsed.searchParams.get("v");
  if (watchId && isValidYouTubeId(watchId)) {
    return watchId;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length >= 2 && ["embed", "shorts", "live"].includes(segments[0])) {
    const candidate = segments[1];
    return isValidYouTubeId(candidate) ? candidate : null;
  }

  if (segments.length >= 1 && isValidYouTubeId(segments[0])) {
    return segments[0];
  }

  return null;
}

function getDropboxShareUrls(rawValue: string): { openUrl: string; playbackUrl: string } | null {
  const parsed = normalizeUrl(rawValue);
  if (!parsed) return null;

  if (!SUPPORTED_DROPBOX_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null;
  }

  const openUrl = parsed.toString();
  const playbackUrl = new URL(parsed.toString());
  playbackUrl.searchParams.delete("dl");
  playbackUrl.searchParams.delete("raw");
  playbackUrl.searchParams.set("raw", "1");

  return {
    openUrl,
    playbackUrl: playbackUrl.toString(),
  };
}

export function toHubVideoEntry(video: HubVideoItem): HubVideoEntry | null {
  const source = video.source ?? "youtube";

  if (source === "dropbox") {
    const dropboxUrls = getDropboxShareUrls(video.url);
    if (!dropboxUrls) return null;

    return {
      ...video,
      source,
      sourceLabel: "Dropbox",
      openUrl: dropboxUrls.openUrl,
      playbackType: "video",
      playbackUrl: dropboxUrls.playbackUrl,
      embedUrl: null,
      thumbnailUrl: null,
    };
  }

  const youtubeId = extractYouTubeVideoId(video.url);
  if (!youtubeId) return null;

  return {
    ...video,
    source,
    sourceLabel: "YouTube",
    openUrl: video.url,
    playbackType: "embed",
    playbackUrl: null,
    embedUrl: `https://www.youtube.com/embed/${youtubeId}?rel=0&modestbranding=1`,
    thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
  };
}

export function getHubVideoLibraryEntries(videos: HubVideoItem[] = HUB_VIDEO_LIBRARY): HubVideoEntry[] {
  return videos
    .map((video) => toHubVideoEntry(video))
    .filter((video): video is HubVideoEntry => video !== null);
}
