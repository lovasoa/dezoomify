import type { DesktopDownloads, DesktopInstaller } from "@dezoomify/shared-ui";

const API = "https://api.github.com/repos/lovasoa/dezoomify/releases/latest";
const DOWNLOAD_PREFIX = "https://github.com/lovasoa/dezoomify/releases/download/";
const INSTALLERS = [
  ["windows", "windows-x86_64.msi"],
  ["macos", "macos-aarch64.dmg"],
  ["linux", "linux-x86_64.deb"],
] as const;

export interface DesktopPlatformHints {
  userAgent?: string;
  platform?: string;
  architecture?: string;
  mobile?: boolean;
}

function preferredPlatform(hints: DesktopPlatformHints): DesktopInstaller["kind"] | undefined {
  const text = `${hints.userAgent ?? ""} ${hints.platform ?? ""}`.toLowerCase();
  if (hints.mobile || /android|iphone|ipad|ipod|mobile/.test(text)) return undefined;
  const arch = (hints.architecture ?? text).toLowerCase();
  if (/windows|win32|win64/.test(text))
    return /arm|aarch|i[3-6]86|\bx86\b/.test(arch) ? undefined : "windows";
  if (/mac/.test(text)) return /intel|x86|amd64/.test(arch) ? undefined : "macos";
  if (/linux/.test(text)) return /arm|aarch|i[3-6]86|\bx86\b/.test(arch) ? undefined : "linux";
  return undefined;
}

function isInstallerAsset(
  asset: unknown,
  suffix: string,
): asset is { browser_download_url: string } {
  if (!asset || typeof asset !== "object") return false;
  const { name, browser_download_url: url } = asset as Record<string, unknown>;
  return (
    typeof name === "string" &&
    /^dezoomify-desktop-v\d+\.\d+\.\d+-(.+)$/.exec(name)?.[1] === suffix &&
    typeof url === "string" &&
    url.startsWith(DOWNLOAD_PREFIX) &&
    url.endsWith(`/${name}`)
  );
}

function releaseAssets(metadata: unknown): unknown[] {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("assets" in metadata) ||
    !Array.isArray(metadata.assets)
  )
    throw new Error("Release lookup returned no assets");
  return metadata.assets;
}

/** A page-session cache. Rejected requests are evicted so the dialog can retry. */
export function createDesktopDownloads(
  fetchRelease: typeof fetch,
  hints: DesktopPlatformHints,
): DesktopDownloads {
  let pending: Promise<DesktopInstaller[]> | undefined;
  const preferred = preferredPlatform(hints);
  return {
    load() {
      pending ??= (async () => {
        const response = await fetchRelease(API, {
          credentials: "omit",
          headers: { Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Release lookup failed (HTTP ${response.status})`);
        const assets = releaseAssets(await response.json());
        const installers: DesktopInstaller[] = [];
        for (const [kind, suffix] of INSTALLERS) {
          const asset = assets.find((asset) => isInstallerAsset(asset, suffix));
          if (asset)
            installers.push({
              kind,
              url: asset.browser_download_url,
              preferred: kind === preferred,
            });
        }
        if (!installers.length)
          throw new Error("No desktop installers are available in this release");
        return installers.sort((a, b) => Number(b.preferred) - Number(a.preferred));
      })().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
  };
}
