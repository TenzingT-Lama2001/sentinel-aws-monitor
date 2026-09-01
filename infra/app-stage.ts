import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { SentinelAwsMonitorStack } from "../infra/sentinel-aws-monitor-stack";


export interface AppStageProps extends cdk.StageProps {
    // Distinguishes environments (e.g. 'Beta', 'Gamma', 'Prod') in the pipeline
    stageLabel: string;
}

// Bundles both regional stacks into one deployable unit for the pipeline's
// deploy stage. Stack names are pinned to match bin/local-deploy.ts, so a
// manual deploy and a pipeline deploy resolve to the same stacks, not duplicates.
export class AppStage extends cdk.Stage {

    constructor(scope: Construct, id: string, props: AppStageProps) {
        super(scope, id, props);

        const account = process.env.AWS_ACCOUNT_ID;
        const { stageLabel } = props;

        new SentinelAwsMonitorStack(this, 'Singapore', {
            stackName: `SentinelAwsMonitorStack-Singapore-${stageLabel}`,
            stage: stageLabel,
            env: { account, region: process.env.REGION_SINGAPORE },
        });

        new SentinelAwsMonitorStack(this, 'Sydney', {
            stackName: `SentinelAwsMonitorStack-Sydney-${stageLabel}`,
            stage: stageLabel,
            env: { account, region: process.env.REGION_SYDNEY },
        });

    }
}