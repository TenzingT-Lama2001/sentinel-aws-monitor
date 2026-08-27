#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib/core";
import { SentinelAwsMonitorStack } from "../infra/sentinel-aws-monitor-stack";

const app = new cdk.App();
new SentinelAwsMonitorStack(app, "SentinelAwsMonitorStack-Sydney", {
  env: {
    account: process.env.AWS_ACCOUNT_ID,
    region: process.env.REGION_SYDNEY,
  },
});

new SentinelAwsMonitorStack(app, "SentinelAwsMonitorStack-Singapore", {
  env: {
    account: process.env.AWS_ACCOUNT_ID,
    region: process.env.REGION_SINGAPORE,
  },
});
