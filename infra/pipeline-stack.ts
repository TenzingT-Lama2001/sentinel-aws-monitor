import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as codestarconnections from 'aws-cdk-lib/aws-codestarconnections';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { AppStage } from './app-stage'


// Repo the pipeline pulls from, via CodeStar Connections.
const GITHUB_OWNER_REPO = 'TenzingT-Lama2001/sentinel-aws-monitor';
const GITHUB_BRANCH = 'samrat/ci-cd-test';


// SSM paths the synth step reads at build time. CodeBuild resolves them at container start.
const SSM_PREFIX = '/sentinel-aws-monitor';

// Default CodeBuild image is Node 18; every step that runs npm ci/tsx needs 20+,
// not just Synth — shared so the post-deploy check steps don't drift from it.
const NODE_20_BUILD_SPEC = codebuild.BuildSpec.fromObject({
    phases: {
        install: {
            'runtime-versions': { nodejs: 20 },
        },
    },
});

// CDK Pipelines instead of GitHub Actions, per the everything-as-code goal:
// CI runs lint/build/test/synth every push; CD deploys both regions after
// manual approval.
export class PipelineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Needs one manual OAuth authorization in the console before first use.
        const githubConnection = new codestarconnections.CfnConnection(this, 'GitHubConnection', {
            connectionName: 'sentinel-aws-monitor-github-v2',
            providerType: 'GitHub',
        });

        // Pulled out so post-deploy check steps (Beta/Gamma, below) can check out
        // the same source too — a CodeBuildStep gets no source at all by default.
        const source = pipelines.CodePipelineSource.connection(GITHUB_OWNER_REPO, GITHUB_BRANCH, {
            connectionArn: githubConnection.attrConnectionArn,
        });

        const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
            pipelineName: 'SentinelAwsMonitorCI',
            synth: new pipelines.CodeBuildStep('Synth', {
                // Equivalent of actions/checkout.
                input: source,
                // Same steps as the old ci.yml, as a plain array.
                commands: [
                    'npm ci',
                    'npm run lint',
                    'npm run build',
                    'npm test',
                    'npx cdk synth',
                ],
                partialBuildSpec: codebuild.BuildSpec.fromObject({
                    phases: {
                        install: {
                            // Default image is Node 18; deps need 20+.
                            'runtime-versions': { nodejs: 20 },
                        },
                    },
                    env: {
                        // Live SSM lookup, not a local .env.
                        'parameter-store': {
                            ALERT_EMAIL: `${SSM_PREFIX}/alert-email`,
                            AWS_ACCOUNT_ID: `${SSM_PREFIX}/aws-account-id`,
                            REGION_SINGAPORE: `${SSM_PREFIX}/region-singapore`,
                            REGION_SYDNEY: `${SSM_PREFIX}/region-sydney`,
                        },
                    },
                }),
                rolePolicyStatements: [
                    // Read access, scoped to this project's SSM path only.
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

        // Beta deployment is followed by a real smoke test.
        // If the smoke test exits with a non-zero status, CodePipeline
        // stops here and Gamma is not deployed.
        pipeline.addStage(
            new AppStage(this, 'Beta', { stageLabel: 'Beta' }),
            {
                post: [new pipelines.CodeBuildStep('BetaSmokeTest', {
                    input: source,
                    commands: [
                        'npm ci',
                        'npm run build',
                        'npx tsx scripts/smoke-test-beta.ts',
                    ],
                    partialBuildSpec: NODE_20_BUILD_SPEC,
                    rolePolicyStatements: [
                        new iam.PolicyStatement({
                            actions: ['cloudformation:DescribeStackResources'],
                            resources: [`arn:aws:cloudformation:*:${this.account}:stack/SentinelAwsMonitorStack-Sydney-Beta/*`],
                        }),
                        // Broader Lambda invoke permission initially to avoid ARN mismatch issues.
                        new iam.PolicyStatement({
                            actions: ['lambda:InvokeFunction'],
                            resources: ['*'],
                        }),
                    ],
                })],
            },
        );

        // Gamma: deeper, end-to-end verification against the real Gamma environment.
        pipeline.addStage(
            new AppStage(this, 'Gamma', { stageLabel: 'Gamma' }),
            {
                post: [new pipelines.CodeBuildStep('GammaVerification', {
                    input: source,
                    commands: [
                        'npm ci',
                        'npm run build',
                        'npx tsx scripts/verify-gamma.ts',
                    ],
                    partialBuildSpec: NODE_20_BUILD_SPEC,
                    rolePolicyStatements: [
                        new iam.PolicyStatement({
                            actions: ['cloudformation:DescribeStackResources'],
                            resources: [`arn:aws:cloudformation:*:${this.account}:stack/SentinelAwsMonitorStack-Sydney-Gamma/*`],
                        }),
                        new iam.PolicyStatement({
                            actions: ['lambda:InvokeFunction'],
                            resources: ['*'],
                        }),
                    ],
                })],
            },
        );


        // Deploys both regions, gated behind manual approval.
        pipeline.addStage(new AppStage(this, 'Production', { stageLabel: 'Prod' }), {
            pre: [new pipelines.ManualApprovalStep('PromoteToProduction')],
        });
        // Prints the ARN to authorize once in the console.
        new cdk.CfnOutput(this, 'GitHubConnectionArn', {
            value: githubConnection.attrConnectionArn,
            description: 'One-time step: AWS Console > Developer Tools > Settings > Connections, '
                + 'find this connection and click "Update pending connection" to authorize GitHub access. '
                + 'The pipeline cannot pull source until this is done once.',
        });
    }
}
