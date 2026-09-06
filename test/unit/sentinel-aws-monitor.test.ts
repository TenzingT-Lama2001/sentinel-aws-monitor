import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import { SentinelAwsMonitorStack } from "../../infra/sentinel-aws-monitor-stack";

describe("SentinelAwsMonitorStack - Unit Tests", () => {
  beforeAll(() => {
    // The stack requires ALERT_EMAIL during synthesis.
    // A dummy value is enough because this is only a CDK template test.
    process.env.ALERT_EMAIL = "test@example.com";
  });

  test("creates the S3 site configuration bucket with public access blocked", () => {
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "UnitTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("creates three Lambda functions", () => {
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "LambdaTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Lambda::Function", 3);
  });

  test("creates the incident DynamoDB table with on-demand billing", () => {
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "DynamoTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

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
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "SnsTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::SNS::Topic", 1);
  });

  test("creates 18 CloudWatch alarms for 6 monitored sites", () => {
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "AlarmTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

    // 6 sites × 3 alarms:
    // Availability + Latency + Certificate Expiry
    template.resourceCountIs("AWS::CloudWatch::Alarm", 18);
  });

  test("creates the monitoring dashboard", () => {
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "DashboardTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  });

  test("creates the five-minute crawler schedule", () => {
    const app = new cdk.App();

    const stack = new SentinelAwsMonitorStack(app, "ScheduleTestStack", {
      stage: "Beta",
      env: {
        account: "123456789012",
        region: "ap-southeast-2",
      },
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(5 minutes)",
    });
  });
});
