/**
 * Crawler Lambda — Phase 2.
 * Reads the monitored-sites list from S3 and checks every site in it,
 * reusing checkSite() from the Phase 1 canary unchanged. One broken site
 * must not stop the others from being checked — see crawl() below.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { checkSite, CheckResult } from "./canary";
import { checkCertificate } from "./certificate";
import { checkDns } from "./dns";
import { MonitoredSite } from "./site-config";
import {
  CloudWatchClient,
  MetricDatum,
  PutMetricDataCommand,
  StandardUnit,
} from "@aws-sdk/client-cloudwatch";
import { validateMonitoredSites } from "../validation/validateMonitoredSites";

const s3 = new S3Client({}); // created once, reused across invocations
const cloudwatch = new CloudWatchClient({});
const CONFIG_BUCKET = process.env.SITE_CONFIG_BUCKET; // set by CDK, no fallback — a missing bucket is fatal
const CONFIG_KEY = process.env.SITE_CONFIG_KEY ?? "sites.json"; // safe default if unset
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE ?? "WebsiteMonitoring";
/** One site's check result, tagged with which site it belongs to. */
export interface CrawlerSiteResult extends CheckResult {
  siteId: string;
  name: string;
  certificateDaysRemaining?: number;
  certificateError?: string;
  dnsResolved?: boolean;
  dnsAddresses?: string[];
  dnsError?: string;
}

/**
 * Downloads and parses the site list from S3.
 * Throws on failure — unlike one site being down, a missing/broken config
 * means there's nothing to crawl at all, so the whole run should stop here.
 */
async function loadSiteConfig(): Promise<MonitoredSite[]> {
  if (!CONFIG_BUCKET) {
    throw new Error("SITE_CONFIG_BUCKET environment variable is not set");
  }

  // fetch the file from S3
  const response = await s3.send(
    new GetObjectCommand({ Bucket: CONFIG_BUCKET, Key: CONFIG_KEY }),
  );

  // S3 returns a stream — convert it to a plain string
  const body = await response.Body?.transformToString();
  if (!body) {
    throw new Error(`s3://${CONFIG_BUCKET}/${CONFIG_KEY} is empty`);
  }

  // parse and sanity-check the JSON before trusting it
  const parsed = JSON.parse(body);
  return validateMonitoredSites(parsed);
  // const sites = JSON.parse(body) as MonitoredSite[];
  // if (!Array.isArray(sites)) {
  //   throw new Error(
  //     `s3://${CONFIG_BUCKET}/${CONFIG_KEY} must contain a JSON array`,
  //   );
  // }

  // return sites;
}

/**
 * Checks every configured site at the same time (not one after another), so
 * a long site list doesn't multiply the Lambda's run time.
 * Promise.allSettled ensures one site throwing unexpectedly still lets every
 * other site's result come back normally.
 */
export async function crawl(): Promise<CrawlerSiteResult[]> {
  const sites = await loadSiteConfig();

  // kick off all checks concurrently
  const outcomes = await Promise.allSettled(
    sites.map(async (site): Promise<CrawlerSiteResult> => {
      const [result, cert, dns] = await Promise.all([
        checkSite(site.url),
        checkCertificate(site.url),
        checkDns(site.url),
      ]);

      return {
        ...result,
        siteId: site.siteId,
        name: site.name,
        certificateDaysRemaining: cert.daysRemaining,
        certificateError: cert.error,
        dnsResolved: dns.resolved,
        dnsAddresses: dns.addresses,
        dnsError: dns.error,
      };
    }),
  );

  // turn allSettled's per-site outcomes back into plain results
  return outcomes.map((outcome, i) => {
    if (outcome.status === "fulfilled") {
      return outcome.value; // normal case — the check completed, up or down
    }

    // Reaching here means something unexpected happened (checkSite() already
    // handles normal network failures itself) — still report it as one
    // failed site, not an aborted run.
    const site = sites[i];
    return {
      siteId: site.siteId,
      name: site.name,
      url: site.url,
      up: false,
      error:
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
    };
  });
}

/**
 * Publishes each site's Availability (always) and Latency only when ip to Cloudwatch, dimensioned by SiteId so each site gets its own tie series under the shared namespace
 */

async function publishMetrics(results: CrawlerSiteResult[]): Promise<void> {
  const timestamp = new Date();

  const metricData: MetricDatum[] = results.flatMap((result) => {
    const dimensions = [
      {
        Name: "SiteId",
        Value: result.siteId,
      },
    ];

    const data: MetricDatum[] = [
      {
        MetricName: "Availability",
        Dimensions: dimensions,
        Timestamp: timestamp,
        Unit: StandardUnit.Count,
        Value: result.up ? 1 : 0,
      },
    ];

    if (result.latencyMs !== undefined) {
      data.push({
        MetricName: "Latency",
        Dimensions: dimensions,
        Timestamp: timestamp,
        Unit: StandardUnit.Milliseconds,
        Value: result.latencyMs,
      });
    }

    if (result.dnsResolved !== undefined) {
      data.push({
        MetricName: "DNSResolution",
        Dimensions: dimensions,
        Timestamp: timestamp,
        Unit: StandardUnit.Count,
        Value: result.dnsResolved ? 1 : 0,
      });
    }

    if (result.certificateDaysRemaining !== undefined) {
      data.push({
        MetricName: "CertificateExpiryDays",
        Dimensions: dimensions,
        Timestamp: timestamp,
        Unit: StandardUnit.Count,
        Value: result.certificateDaysRemaining,
      });
    }

    return data;
  });

  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: metricData,
    }),
  );
}
/**
 * Lambda entry point. The incoming event is ignored — every run checks the
 * same configured site list regardless of what triggered it.
 */
export async function handler(): Promise<CrawlerSiteResult[]> {
  const results = await crawl();

  console.log(JSON.stringify(results)); // shows up in CrawlerLogGroup

  await publishMetrics(results);
  return results;
}
