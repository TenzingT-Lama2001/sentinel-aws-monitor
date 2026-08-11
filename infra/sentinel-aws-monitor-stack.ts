import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

// Filename the crawler reads from S3; shared so the bucket grant and the
// Lambda's env var always agree on the same file.
const SITE_CONFIG_KEY = 'sites.json';

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


    // run the crawler autoatically every 5 minutes instead of manual invocation

    //using rate based scheduler

    const rule = new events.Rule(this, 'CrawlerRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
    });
    rule.addTarget(new targets.LambdaFunction(crawlerFunction));
  }
}