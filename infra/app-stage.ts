import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { SentinelAwsMonitorStack } from "../infra/sentinel-aws-monitor-stack";

// Wraps both regional AdvPStack deployments as a single deployable unit for
// the pipeline's deploy stage (lib/pipeline-stack.ts) — the only place this
// is used from. Stack names are pinned explicitly to match the standalone
// `new AdvPStack(...)` calls in bin/local-deploy.ts (see README), so a
// manual local deploy and a pipeline-driven deploy always resolve to the
// exact same CloudFormation stacks rather than creating duplicates.
export class AppStage extends cdk.Stage {
    constructor(scope: Construct, id: string, props?: cdk.StageProps) {
        super(scope, id, props);

        const account = process.env.AWS_ACCOUNT_ID;

        new SentinelAwsMonitorStack(this, 'Singapore', {
            stackName: 'SentinelAwsMonitorStack-Singapore',
            env: { account, region: process.env.REGION_SINGAPORE },
        });

        new SentinelAwsMonitorStack(this, 'Sydney', {
            stackName: 'SentinelAwsMonitorStack-Sydney',
            env: { account, region: process.env.REGION_SYDNEY },
        });

    }
}
