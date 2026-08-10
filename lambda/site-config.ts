/**
 * Shape of one entry in the monitored-sites JSON config stored in S3
 * (Sub-Phase 2.1). See docs/METRICS.md for the check semantics applied to every
 * site, and the System Analysis and Design Report's Table 2 for the underlying
 * data types/sizes this schema follows.
 */
export interface MonitoredSite {
  siteId: string;
  name: string;
  url: string;
}
