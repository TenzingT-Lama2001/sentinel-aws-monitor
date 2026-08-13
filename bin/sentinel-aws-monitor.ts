#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SentinelAwsMonitorStack } from '../infra/sentinel-aws-monitor-stack';

const app = new cdk.App();
new SentinelAwsMonitorStack(app, 'SentinelAwsMonitorStack', {
  env: { account: process.env.AWS_ACCOUNT_ID, region: process.env.AWS_REGION_SYDNEY },
});

new SentinelAwsMonitorStack(app, 'SentinelAwsMonitorStack-Singapore', {
  env: { account: process.env.AWS_ACCOUNT_ID, region: process.env.AWS_REGION_SINGAPORE },
});
