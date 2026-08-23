#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib/core";
import { SentinelAwsMonitorStack } from "../infra/sentinel-aws-monitor-stack";

const app = new cdk.App();

const awsAccountId = process.env.AWS_ACCOUNT_ID;
const awsRegionSydney = process.env.AWS_REGION_SYDNEY;
const awsRegionSingapore = process.env.AWS_REGION_SINGAPORE;

if (!awsAccountId || !awsRegionSydney || !awsRegionSingapore) {
  throw new Error("Required environment variables are not set: AWS_ACCOUNT_ID, AWS_REGION_SYDNEY, AWS_REGION_SINGAPORE");
}

new SentinelAwsMonitorStack(app, "SentinelAwsMonitorStack-Sydney", {
  env: {
    account: awsAccountId,
    region: awsRegionSydney,
  },
});

new SentinelAwsMonitorStack(app, "SentinelAwsMonitorStack-Singapore", {
  env: {
    account: awsAccountId,
    region: awsRegionSingapore,
  },
});