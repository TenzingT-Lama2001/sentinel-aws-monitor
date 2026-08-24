import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as codestarconnections from 'aws-cdk-lib/aws-codestarconnections';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { AppStage } from './app-stage'

// Source repo the pipeline pulls from. CodeStar Connections (below) is the
// AWS-recommended way to authorize GitHub access — the alternative, a
// personal access token in Secrets Manager, means a token to rotate/leak.
const GITHUB_OWNER_REPO = 'TenzingT-Lama2001/sentinel-aws-monitor';
const GITHUB_BRANCH = 'tenzing/ci-cd';

// SSM Parameter Store names the synth step reads its env vars from at build
// time (see README's "Pipeline Setup" section for the one-time `aws ssm
// put-parameter` commands that create these). Values never appear in the
// CloudFormation template — CodeBuild resolves them at container start.
const SSM_PREFIX = '/sentinel-aws-monitor';

// CDK Pipelines (the "L3" pipelines module) instead of GitHub Actions, per
// the project's everything-as-code goal:
//  - CI: synth step runs lint/build/test/synth on every push.
//  - CD: deploys AppStage (both AdvPStack regions) after a manual approval,
//    so nothing touches real AWS resources without a human clicking approve.
export class PipelineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Created here as code rather than pre-provisioned by hand, but AWS still
        // requires a one-time manual OAuth authorization in the console before
        // the connection can actually pull from GitHub — see the
        // GitHubConnectionArn output below.
        const githubConnection = new codestarconnections.CfnConnection(this, 'GitHubConnection', {
            connectionName: 'sentinel-aws-monitor-github',
            providerType: 'GitHub',
        });

        const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
            pipelineName: 'SentinelAwsMonitorCI',
            synth: new pipelines.CodeBuildStep('Synth', {
                input: pipelines.CodePipelineSource.connection(GITHUB_OWNER_REPO, GITHUB_BRANCH, {
                    connectionArn: githubConnection.attrConnectionArn,
                }),
                commands: [
                    'npm ci',
                    'npm run lint',
                    'npm run build',
                    'npm test',
                    'npx cdk synth',
                ],
                // AdvPStack's constructor reads these from process.env at synth
                // time (see lib/adv-p-stack.ts / lib/app-stage.ts) to pick its
                // deploy account/region and validate ALERT_EMAIL is set — CodeBuild
                // injects them as real env vars before `commands` runs.
                partialBuildSpec: codebuild.BuildSpec.fromObject({
                    env: {
                        'parameter-store': {
                            ALERT_EMAIL: `${SSM_PREFIX}/alert-email`,
                            AWS_ACCOUNT_ID: `${SSM_PREFIX}/aws-account-id`,
                            REGION_SINGAPORE: `${SSM_PREFIX}/region-singapore`,
                            REGION_SYDNEY: `${SSM_PREFIX}/region-sydney`,
                        },
                    },
                }),
                rolePolicyStatements: [
                    new iam.PolicyStatement({
                        actions: ['ssm:GetParameters'],
                        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_PREFIX}/*`],
                    }),
                    new iam.PolicyStatement({
                        // SecureString values are encrypted under the account's default
                        // SSM KMS key (alias/aws/ssm); GetParameters needs Decrypt on it
                        // too. The alias has no fixed ARN to scope this to, hence '*'.
                        actions: ['kms:Decrypt'],
                        resources: ['*'],
                    }),
                ],
            }),
        });

        // CD: deploy both AdvPStack regions, gated behind a manual approval so a
        // push to main never touches real AWS resources unattended.
        pipeline.addStage(new AppStage(this, 'Production'), {
            pre: [new pipelines.ManualApprovalStep('PromoteToProduction')],
        });

        new cdk.CfnOutput(this, 'GitHubConnectionArn', {
            value: githubConnection.attrConnectionArn,
            description: 'One-time step: AWS Console > Developer Tools > Settings > Connections, '
                + 'find this connection and click "Update pending connection" to authorize GitHub access. '
                + 'The pipeline cannot pull source until this is done once.',
        });
    }
}
