import * as path from "path";
import * as fs from "fs";
import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { MonitoredSite } from "../lambda/site-config";
import { validateMonitoredSites } from "../validation/validateMonitoredSites";

// Filename the crawler reads from S3 — shared so the bucket grant and the
// Lambda's env var always agree on the same file (see docs/METRICS.md).
const SITE_CONFIG_KEY = "sites.json";

// CloudWatch namespace the crawler publishes Availability/Latency under —
// shared between the IAM condition below and the crawler's env var.
const METRIC_NAMESPACE = "WebsiteMonitoring";

// SSM SecureString parameter holding the Slack Incoming Webhook URL for
// real-time alarm notifications. Created once by hand, per region
// (`aws ssm put-parameter --type SecureString`) — CDK only references it,
// never creates or destroys it. See docs/notifications-design.md.
const SLACK_ALERTS_WEBHOOK_PARAM = "/sentinel/slack/alerts-webhook-url";

export class SentinelAwsMonitorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Site configuration storage
    // ---------------------------------------------------------------------

    /**
     * Holds the monitored-sites JSON config. Uploaded manually
     * rather than deployed by CDK, so the site list can change without a
     * redeploy. Destroyed with the stack, safe here since it only ever
     * holds this one small config file.
     */
    const siteConfigBucket = new s3.Bucket(this, "SiteConfigBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // never allow public access
      enforceSSL: true, // reject non-HTTPS requests
      removalPolicy: cdk.RemovalPolicy.DESTROY, // delete bucket on cdk destroy
      autoDeleteObjects: true, // empty it first, so destroy doesn't fail
    });

    // ---------------------------------------------------------------------
    // Crawler Lambda (Phase 2) — checks every site in the S3 config,
    // triggered automatically on a schedule
    // ---------------------------------------------------------------------

    const crawlerFunction = new NodejsFunction(this, "CrawlerFunction", {
      entry: path.join(__dirname, "..", "lambda", "crawler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(20), // checks run concurrently — ~one check's worth (HTTP + TLS probe each cap at 5s), plus S3 fetch and headroom
      memorySize: 256,
      logGroup: this.createLogGroup("CrawlerLogGroup"),
      environment: {
        SITE_CONFIG_BUCKET: siteConfigBucket.bucketName, // which bucket to read
        SITE_CONFIG_KEY, // which file in it
      },
      bundling: {
        bundleAwsSDK: true, // pin our tested SDK version instead of the runtime's default
      },
    });

    // Read-only, scoped to exactly the one config object, not the whole bucket.
    siteConfigBucket.grantRead(crawlerFunction, SITE_CONFIG_KEY);

    // CloudWatch metrics have no ARN to grant against, so least-privilege
    // here means scoping by namespace via a condition instead of a resource.
    crawlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": METRIC_NAMESPACE },
        },
      }),
    );

    // Run the crawler automatically every 5 minutes (EventScheduler)
    new events.Rule(this, "CrawlerRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(crawlerFunction)],
    });

    // ---------------------------------------------------------------------
    // Incident logging (Phase 3) — DynamoDB table + fan-out Lambda
    // ---------------------------------------------------------------------

    /**
     * Incident table. `siteId` partitions the table so "every incident for
     * this site" is a single-partition query. The `incidentId` sort key is
     * `"<stateChangeTime>#<alarmName>"` — the timestamp leads so the rows
     * still sort chronologically (ISO-8601 sorts correctly as plain text),
     * and the `#<alarmName>` suffix keeps two alarms that flip in the same
     * instant from sharing a key and silently overwriting each other. Both
     * the ALARM and the matching OK (recovery) row coexist under the site.
     */
    const incidentTable = new dynamodb.Table(this, 'IncidentTable', {
      tableName: `WebsiteMonitoringIncidents-${this.region}`,
      partitionKey: { name: 'siteId', type: dynamodb.AttributeType.STRING },     // groups rows by site
      sortKey: { name: 'incidentId', type: dynamodb.AttributeType.STRING },      // "<stateChangeTime>#<alarmName>" — orders by time, unique per alarm
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // write volume never justifies provisioned capacity
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Fan-out Lambda: turns each alarm-state-change SNS notification into
     * a durable row in the incident table.
     */
    const incidentLoggerFunction = new NodejsFunction(this, 'IncidentLoggerFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'incident-logger.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logGroup: this.createLogGroup('IncidentLoggerLogGroup'),
      environment: {
        INCIDENT_TABLE_NAME: incidentTable.tableName,
      },
      bundling: {
        bundleAwsSDK: true,
      },
    });

    incidentTable.grantWriteData(incidentLoggerFunction);

    /**
     * Second fan-out Lambda on the same alarm topic: posts a short
     * human-readable line to Slack for every alarm/OK transition. Independent
     * of the email subscription and the incident logger — purely additive,
     * touches neither.
     */
    const slackNotifierFunction = new NodejsFunction(this, 'SlackNotifierFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'slack-notifier.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logGroup: this.createLogGroup('SlackNotifierLogGroup'),
      environment: {
        SLACK_WEBHOOK_PARAM_NAME: SLACK_ALERTS_WEBHOOK_PARAM,
      },
      bundling: {
        bundleAwsSDK: true,
      },
    });

    /**
     * The webhook URL is a bearer secret, stored as a SecureString created
     * manually (once per region). Reference it — never create it — so
     * `cdk destroy` can't delete it and the value survives every redeploy.
     * `grantRead` scopes the Lambda to `ssm:GetParameter*` on just this
     * parameter's ARN; decryption goes through the AWS-managed `aws/ssm`
     * key, which needs no extra KMS grant for same-account SSM calls.
     */
    const slackWebhookParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'SlackAlertsWebhookParam',
      { parameterName: SLACK_ALERTS_WEBHOOK_PARAM },
    );
    slackWebhookParam.grantRead(slackNotifierFunction);

    // ---------------------------------------------------------------------
    // Alerting — shared SNS topic for every alarm across every site
    // ---------------------------------------------------------------------

    /**
     * Alarms (defined per-site below) publish state changes here. One
     * topic for the whole stack, alarms are tagged by metric type instead
     * of splitting into per-metric topics, which would just multiply the
     * number of things to subscribe to for no real benefit at this scale.
     */
    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: `WebsiteMonitoringAlerts-${this.region}`,
    });

    // SNS emails a confirmation link to this address on first deploy; it
    // must be clicked before alerts start arriving.
    const alertEmail = process.env.ALERT_EMAIL;
    if (!alertEmail) {
      throw new Error(
        "Please set the ALERT_EMAIL environment variable (see .env.example)",
      );
    }
    alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));

    // Second subscriber on the same topic — every alarm/OK event reaches
    // both the human (email, above) and the incident logger, independently.
    alertTopic.addSubscription(new subscriptions.LambdaSubscription(incidentLoggerFunction));

    // Third subscriber — same event again, this time posted to Slack.
    // Independent of the two above: a Slack outage can't affect email or
    // incident logging, and vice versa.
    alertTopic.addSubscription(new subscriptions.LambdaSubscription(slackNotifierFunction));

    // ---------------------------------------------------------------------
    // Dashboard + per-site metrics, widgets, and alarms
    // ---------------------------------------------------------------------

    /**
     * Reads the monitored-sites list from the same config the crawler reads
     * from S3 at runtime, so the dashboard/alarms can't drift out of sync
     * with the actual monitored-sites list.
     */
    const monitoredSites: MonitoredSite[] = validateMonitoredSites(
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "config", "sites.json"),
          "utf-8",
        ),
      ),
    );

    const dashboard = new cloudwatch.Dashboard(this, "MonitoringDashboard", {
      // Region-suffixed because dashboard names must be unique per account
      dashboardName: `WebsiteMonitoring-${this.region}`,
    });

    for (const site of monitoredSites) {
      const dimensionsMap = { SiteId: site.siteId };

      const availability = new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "Availability",
        dimensionsMap,
        statistic: "Average", // % of checks that succeeded in each period
        period: cdk.Duration.minutes(5), // matches the crawler's schedule
      });

      const latency = new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "Latency",
        dimensionsMap,
        statistic: "Average",
        period: cdk.Duration.minutes(5),
      });

      const certExpiry = new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: "CertificateExpiryDays",
        dimensionsMap,
        statistic: "Minimum", // the closest-to-expiry reading in the period
        // TESTING: matches the crawler's 5-min schedule so new datapoints show up
        // immediately on the dashboard. Reverted to Duration.hours(1) later
        // the value only moves once a day in real use, so 5-min is just noise long-term.
        period: cdk.Duration.minutes(5),
      });

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${site.name} — Availability`,
          left: [availability],
          leftYAxis: { min: 0, max: 1 }, // Availability is always 0–1 — pin the axis so a healthy
          // site's flat line at 1 doesn't get auto-scaled into noise
          width: 8, // a third of the dashboard's 24-column row — all 3 widgets fit on one row
        }),
        new cloudwatch.GraphWidget({
          title: `${site.name} — Latency (ms)`,
          left: [latency],
          width: 8,
        }),
        new cloudwatch.GraphWidget({
          title: `${site.name} — TLS cert days remaining`,
          left: [certExpiry],
          leftYAxis: { min: 0 }, // clip the "expired" negatives — the alarm covers those
          width: 8,
        }),
      );

      // Thresholds.
      // Reuses the same Metric objects the widgets above are built from, so the alarm
      // and the graph can never drift out of sync with each other.
      const availabilityAlarm = availability.createAlarm(
        this,
        `AvailabilityAlarm-${site.siteId}`,
        {
          alarmName: `${this.stackName}-Availability-${site.siteId}`,
          alarmDescription: `${site.name} has been down for 2 consecutive checks (10 min)`,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, // averaged value below 1 = a check failed
          threshold: 1,
          evaluationPeriods: 3, // look at the last 3 periods (3 × 5 min = 15 min window)
          datapointsToAlarm: 3,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING, // no data is exactly as bad as a failing check
        },
      );

      const latencyAlarm = latency.createAlarm(
        this,
        `LatencyAlarm-${site.siteId}`,
        {
          alarmName: `${this.stackName}-Latency-${site.siteId}`,
          alarmDescription: `${site.name} latency has exceeded 3000ms for 2 consecutive checks (10 min)`,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          threshold: 3000,
          evaluationPeriods: 2,
          datapointsToAlarm: 2,
          // Missing data → INSUFFICIENT_DATA (not OK). A latency gap means the
          // crawler stopped producing data for this site; surface it as its
          // own "no data" signal rather than a misleading green. The
          // availability alarm still owns "the site is down".
          treatMissingData: cloudwatch.TreatMissingData.MISSING,
        },
      );

      const certExpiryAlarm = certExpiry.createAlarm(
        this,
        `CertExpiryAlarm-${site.siteId}`,
        {
          alarmName: `${this.stackName}-CertExpiry-${site.siteId}`,
          alarmDescription: `${site.name} TLS certificate expires in under 14 days`,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          threshold: 14, // days — enough lead time to renew before it bites
          evaluationPeriods: 1, // the value is stable, no need to wait for confirmation
          datapointsToAlarm: 1,
          // Missing data → INSUFFICIENT_DATA (not OK). No cert reading usually
          // means the TLS handshake failed — worth its own "no data" signal in
          // Slack. The availability alarm still owns "the site is down".
          treatMissingData: cloudwatch.TreatMissingData.MISSING,
        },
      );

      // Both ALARM and OK transitions notify,
      //  OK is what lets the incident logger record a recovery, not just an outage.
      for (const alarm of [availabilityAlarm, latencyAlarm, certExpiryAlarm]) {
        alarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
        alarm.addOkAction(new cwActions.SnsAction(alertTopic));
      }

      // Latency and cert use treatMissingData: MISSING, so a data gap lands
      // them in INSUFFICIENT_DATA. Notify on that too — the Slack notifier
      // turns it into a "⚠️ NO DATA" line; the incident logger ignores it.
      // Availability is BREACHING (no data = assume down), so it never sits
      // in INSUFFICIENT_DATA and isn't wired here.
      for (const alarm of [latencyAlarm, certExpiryAlarm]) {
        alarm.addInsufficientDataAction(new cwActions.SnsAction(alertTopic));
      }

      // Tagged by metric type (FR8), lets alarms be filtered/searched in
      // the console without parsing alarm names.
      cdk.Tags.of(availabilityAlarm).add("MetricType", "Availability");
      cdk.Tags.of(latencyAlarm).add("MetricType", "Latency");
      cdk.Tags.of(certExpiryAlarm).add("MetricType", "CertificateExpiry");
    }

    const dashboardUrl = `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`;

    // The Slack notifier links to this from every message. Set here (not in
    // the function's `environment` block above) because the dashboard is
    // defined further down the file than the Lambda.
    slackNotifierFunction.addEnvironment("DASHBOARD_URL", dashboardUrl);

    // Printed after `cdk deploy` so the dashboard is one click away instead
    // of having to hunt for it by name in the console.
    new cdk.CfnOutput(this, "DashboardUrl", { value: dashboardUrl });
  }

  /**
   * Creates a CloudWatch Log Group with the project's standard retention
   * and removal settings, so every Lambda's logs behave consistently
   * without repeating the same config at every call site.
   */
  private createLogGroup(id: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      retention: logs.RetentionDays.ONE_WEEK, // auto-delete old logs, keeps cost predictable
      removalPolicy: cdk.RemovalPolicy.DESTROY, // delete log group on cdk destroy
    });
  }
}
