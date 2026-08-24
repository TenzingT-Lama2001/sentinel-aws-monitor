#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib/core";
import { PipelineStack } from "../infra/pipeline-stack";

const app = new cdk.App();
new PipelineStack(app, 'PipelineStack', {
  env: { account: process.env.AWS_ACCOUNT_ID, region: process.env.REGION_SINGAPORE },
});
