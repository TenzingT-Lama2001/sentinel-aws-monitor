import * as path from 'path';
import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { MonitoredSite } from '../lambda/site-config';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';


// Filename the crawler reads from S3; shared so the bucket grant and the
// Lambda's env var always agree on the same file.
const SITE_CONFIG_KEY = 'sites.json';

const METRIC_NAMESPACE = 'WebsiteMonitoring';
export class SentinelAwsMonitorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Stores the monitored-sites JSON config.
    const siteConfigBucket = new s3.Bucket(this, 'SiteConfigBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // never allow public access
      enforceSSL: true,                                  // reject non-HTTPS requests
      removalPolicy: cdk.RemovalPolicy.DESTROY,           // delete bucket on cdk destroy
      autoDeleteObjects: true,                            // empty it first, so destroy doesn't fail
    });

    // Canary Lambda's log destination.
    const canaryLogGroup = new logs.LogGroup(this, 'CanaryLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,     // auto-delete old logs, keeps cost predictable
      removalPolicy: cdk.RemovalPolicy.DESTROY,   // delete log group on cdk destroy
    });

    // Canary Lambda (Phase 1): checks a single site, manually invoked.
    new NodejsFunction(this, 'CanaryFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'canary.ts'), // source file to bundle
      handler: 'handler',                  // exported function to invoke
      runtime: Runtime.NODEJS_24_X,        // Lambda execution environment
      timeout: cdk.Duration.seconds(10),   // headroom above the 5s check timeout
      memorySize: 128,                     // minimum size, enough for one HTTP check
      logGroup: canaryLogGroup,            // send logs here, not an auto-created default
      // no `role` set — CDK generates a minimal one (logs only); more permissions
      // get added later, only when a phase actually needs them
    });

    // Crawler Lambda's log destination (kept separate from the canary's).
    const crawlerLogGroup = new logs.LogGroup(this, 'CrawlerLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Crawler Lambda (Phase 2): checks every site in the S3 config, manually invoked.
    const crawlerFunction = new NodejsFunction(this, 'CrawlerFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'crawler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(15),   // checks run concurrently, so ~one check's worth, plus S3 fetch overhead
      memorySize: 256,                     // more than the canary — holds multiple concurrent results
      logGroup: crawlerLogGroup,
      environment: {
        SITE_CONFIG_BUCKET: siteConfigBucket.bucketName, // which bucket to read
        SITE_CONFIG_KEY,                                 // which file in it
      },
      bundling: {
        bundleAwsSDK: true, // pin our tested SDK version instead of the runtime's default
      },
    });

    // Grant read access to just sites.json — not the whole bucket.
    siteConfigBucket.grantRead(crawlerFunction, SITE_CONFIG_KEY);

    // allow the crawler to publish Availability/Latency metrics.
    // CloudWatch metrics have no ARN to grant against, so least-privilege here
    // means scoping by namespace via a condition instead of a resource.
    crawlerFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE },
      },
    }));

    //run the crawler autoatically every 5 minutes instead of manual invocation using rate based scheduler

    const rule = new events.Rule(this, 'CrawlerRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    rule.addTarget(new targets.LambdaFunction(crawlerFunction));

// ============================================================
// SNS TOPIC FOR CLOUDWATCH ALARM NOTIFICATIONS
// ============================================================

const alarmTopic = new sns.Topic(this, 'SentinelAlarmTopic', {
  displayName: 'Sentinel Website Monitoring Alerts',
});

// Subscribe an email address to the SNS topic.
// The recipient must confirm the subscription from their email.
alarmTopic.addSubscription(
  new subscriptions.EmailSubscription(
    'youractualemail@gmail.com'
  )
);

    /**
     * dashboard with per-site Availability/Latency widgets
     * reads from the config/sites.json at synth time
     */

    const monitoredSites: MonitoredSite[] = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config', 'sites.json'), 'utf-8'),
    );

    const dashboard = new cloudwatch.Dashboard(this, `WebsiteMonitoringDashboard`, {
      dashboardName: `WebsiteMonitoringDashboard`,
    })

    for (const site of monitoredSites) {
      const dimensionsMap = { SiteId: site.siteId }

      const availability = new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'Availability',
        dimensionsMap,
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      })

const availabilityAlarm = new cloudwatch.Alarm(
  this,
  `${site.siteId}AvailabilityAlarm`,
  {
    alarmName: `Sentinel-${site.siteId}-Availability`,
    alarmDescription: `Availability alarm for ${site.name}`,

    metric: availability,

    threshold: 1,

    evaluationPeriods: 1,

    comparisonOperator:
      cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,

    treatMissingData:
      cloudwatch.TreatMissingData.NOT_BREACHING,
  }
);

availabilityAlarm.addAlarmAction(
  new cloudwatchActions.SnsAction(alarmTopic)
);


      const latency = new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'Latency',
        dimensionsMap,
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
      })

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${site.name} — Availability`,
          left: [availability],
          leftYAxis: { min: 0, max: 1 },
          width: 12,
        }),
        new cloudwatch.GraphWidget({
          title: `${site.name} — Latency (ms)`,
          left: [latency],
          width: 12,
        }),
      );

    }
    // Printed after `cdk deploy` so the dashboard is one click away instead of
    // having to hunt for it by name in the console.
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    });



  }
}
