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
import type { MonitoredSite } from "../lambda/site-config";
import { validateMonitoredSites } from "../validation/validateMonitoredSites";

// Filename the crawler reads from S3 — shared so the bucket grant and the
// Lambda's env var always agree on the same file (see docs/METRICS.md).
const SITE_CONFIG_KEY = "sites.json";

// CloudWatch namespace the crawler publishes Availability/Latency under —
// shared between the IAM condition below and the crawler's env var.
const METRIC_NAMESPACE = "WebsiteMonitoring";

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
    const siteConfigBucket = new s3.Bucket(this, 'SiteConfigBucket', {
      bucketName: `sentinel-site-config-${this.stackName.toLowerCase()}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---------------------------------------------------------------------
    // Crawler Lambda (Phase 2) — checks every site in the S3 config,
    // triggered automatically on a schedule
    // ---------------------------------------------------------------------

    const crawlerFunction = new NodejsFunction(this, "CrawlerFunction", {
      entry: path.join(__dirname, "..", "lambda", "crawler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(15), // checks run concurrently — ~one check's worth, plus S3 fetch overhead
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
     * this site" is a single-partition query; `timestamp` as sort key
     * orders each site's incidents chronologically and lets both the ALARM
     * and the matching OK (recovery) row coexist under the same site.
     */
    // const incidentTable = new dynamodb.Table(this, 'IncidentTable', {
    //   tableName: `WebsiteMonitoringIncidents-${this.region}`,
    //   partitionKey: { name: 'siteId', type: dynamodb.AttributeType.STRING },  // groups rows by site
    //   sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },    // orders each site's incidents
    //   billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // write volume never justifies provisioned capacity
    //   removalPolicy: cdk.RemovalPolicy.DESTROY,
    // });

    /**
     * Fan-out Lambda: turns each alarm-state-change SNS notification into
     * a durable row in the incident table.
     */
    // const incidentLoggerFunction = new NodejsFunction(this, 'IncidentLoggerFunction', {
    //   entry: path.join(__dirname, '..', 'lambda', 'incident-logger.ts'),
    //   handler: 'handler',
    //   runtime: Runtime.NODEJS_24_X,
    //   timeout: cdk.Duration.seconds(10),
    //   memorySize: 128,
    //   logGroup: this.createLogGroup('IncidentLoggerLogGroup'),
    //   environment: {
    //     INCIDENT_TABLE_NAME: incidentTable.tableName,
    //   },
    //   bundling: {
    //     bundleAwsSDK: true,
    //   },
    // });

    // incidentTable.grantWriteData(incidentLoggerFunction);

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
      // Keyed by stack name, not just region — multiple stages (Beta/Gamma/Prod)
      // deploy to the same account+region, and topic names must be unique there.
      topicName: `WebsiteMonitoringAlerts-${this.stackName}`,
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
    // alertTopic.addSubscription(new subscriptions.LambdaSubscription(incidentLoggerFunction));

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
      // Keyed by stack name, not just region — multiple stages (Beta/Gamma/Prod)
      // deploy to the same account+region, and dashboard names must be unique there.
      dashboardName: `WebsiteMonitoring-${this.stackName}`,
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

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${site.name} — Availability`,
          left: [availability],
          leftYAxis: { min: 0, max: 1 }, // Availability is always 0–1 — pin the axis so a healthy
          // site's flat line at 1 doesn't get auto-scaled into noise
          width: 12, // half the dashboard's 24-column row
        }),
        new cloudwatch.GraphWidget({
          title: `${site.name} — Latency (ms)`,
          left: [latency],
          width: 12,
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
          // A down site has no latency data point at all that's already
          // covered by the availability alarm above, so missing data here
          // shouldn't also fire a second, redundant alarm for the same outage.
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );

      // Both ALARM and OK transitions notify,
      //  OK is what lets the incident logger record a recovery, not just an outage.
      for (const alarm of [availabilityAlarm, latencyAlarm]) {
        alarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
        alarm.addOkAction(new cwActions.SnsAction(alertTopic));
      }

      // Tagged by metric type (FR8), lets alarms be filtered/searched in
      // the console without parsing alarm names.
      cdk.Tags.of(availabilityAlarm).add("MetricType", "Availability");
      cdk.Tags.of(latencyAlarm).add("MetricType", "Latency");
    }

    // Printed after `cdk deploy` so the dashboard is one click away instead
    // of having to hunt for it by name in the console.
    new cdk.CfnOutput(this, "DashboardUrl", {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    });
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
