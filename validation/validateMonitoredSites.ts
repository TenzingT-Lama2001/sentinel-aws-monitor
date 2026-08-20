import type { MonitoredSite } from "../lambda/site-config";
/**
 * Validates the parsed sites.json against the shape the rest of the stack assumes.
 * Throws a specific error at synth time instead of letting
 * a malformed config silently produce broken dashboard widgets or alarms
 * that are hard to trace back to their actual cause.
 */
export function validateMonitoredSites(data: unknown): MonitoredSite[] {
  if (!Array.isArray(data)) {
    throw new Error("sites.json must contain a JSON array of sites");
  }

  data.forEach((site, index) => {
    if (typeof site.siteId !== "string" || site.siteId.trim() === "") {
      throw new Error(`sites.json entry ${index}: missing or invalid "siteId"`);
    }
    if (typeof site.name !== "string" || site.name.trim() === "") {
      throw new Error(
        `sites.json entry ${index} (${site.siteId}): missing or invalid "name"`,
      );
    }
    if (typeof site.url !== "string" || !site.url.startsWith("http")) {
      throw new Error(
        `sites.json entry ${index} (${site.siteId}): missing or invalid "url"`,
      );
    }
  });

  return data as MonitoredSite[];
}
