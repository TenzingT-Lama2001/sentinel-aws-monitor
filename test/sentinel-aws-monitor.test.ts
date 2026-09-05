import * as cdk from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import { SentinelAwsMonitorStack } from "../infra/sentinel-aws-monitor-stack";

describe("Sentinel AWS Monitor Infrastructure", () => {
  let template: Template;

  beforeAll(() => {
    process.env.ALERT_EMAIL = "test@example.com";

    process.env.AWS_ACCOUNT_ID = "123456789012";
    process.env.REGION_SINGAPORE = "ap-southeast-1";
    process.env.REGION_SYDNEY = "ap-southeast-2";

    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "TestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    template = Template.fromStack(stack);
  });

  test("creates the site configuration S3 bucket", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);

    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("creates the monitoring Lambda functions", () => {
    template.resourceCountIs("AWS::Lambda::Function", 3);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
    });
  });

  test("creates the incident DynamoDB table", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        {
          AttributeName: "siteId",
          KeyType: "HASH",
        },
        {
          AttributeName: "incidentId",
          KeyType: "RANGE",
        },
      ],
    });
  });

  test("creates the SNS alert topic", () => {
    template.hasResourceProperties("AWS::SNS::Topic", {
      TopicName: Match.stringLikeRegexp("WebsiteMonitoringAlerts-.*"),
    });
  });

  test("creates CloudWatch alarms", () => {
    template.resourceCountIs("AWS::CloudWatch::Alarm", 18);
  });

  test("creates the monitoring dashboard", () => {
    template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: Match.stringLikeRegexp("WebsiteMonitoring-.*"),
    });
  });

  test("creates the crawler schedule", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(5 minutes)",
    });
  });
});
