import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as codestarconnections from 'aws-cdk-lib/aws-codestarconnections';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { AppStage } from './app-stage'


// Repo the pipeline pulls from, via CodeStar Connections.
const GITHUB_OWNER_REPO = 'TenzingT-Lama2001/sentinel-aws-monitor';
const GITHUB_BRANCH = 'tenzing/secondary-metrics';


// SSM paths the synth step reads at build time. CodeBuild resolves them at container start.
const SSM_PREFIX = '/sentinel-aws-monitor';

// Default CodeBuild image is Node 18; every step that runs npm ci/tsx needs 20+,
// not just Synth -shared so the post-deploy check steps don't drift from it.
const NODE_20_BUILD_SPEC = codebuild.BuildSpec.fromObject({
    phases: {
        install: {
            'runtime-versions': { nodejs: 20 },
        },
    },
});

// Bake step just needs the window length.
const BAKE_BUILD_SPEC = codebuild.BuildSpec.fromObject({
    phases: {
        install: {
            'runtime-versions': { nodejs: 20 },
        },
    },
    env: {
        variables: {
            BAKE_MINUTES: '0',
        },
    },
});

// CDK Pipelines instead of GitHub Actions, per the everything-as-code goal.
// Test strategy follows the AWS deployment-pipeline model — each stage runs a
// different kind of test, cheapest first, against a progressively more
// realistic environment:
//   Synth  - lint + build + cdk synth only (no tests; is it even valid code?)
//   Alpha  - unit tests, no deploy          (test/unit,       npm run test:unit)
//   Beta   - functional tests vs deployed Beta   (test/functional, test:functional)
//   Gamma  - end-to-end tests, THEN a bake time (hold the window so the stack's
//            alarms can fire on a bad build) before the prod gate
//   Prod   - manual approval, then deploy both regions
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
                commands: [
                    'npm ci',
                    'npm run lint',
                    'npm run build',
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

        // Alpha: unit tests 
        pipeline.addStage(new AppStage(this, 'Alpha', { stageLabel: 'Alpha' }), {
            post: [new pipelines.CodeBuildStep('AlphaUnitTests', {
                input: source,
                commands: ['npm ci', 'npm run test:unit'],
                partialBuildSpec: NODE_20_BUILD_SPEC,
            })],
        });

        // Beta: no gate, fast first check. Post-deploy functional tests run
        // against the real deployed Beta resources, so a broken deploy never
        // reaches Gamma.
        pipeline.addStage(new AppStage(this, 'Beta', { stageLabel: 'Beta' }), {
            post: [new pipelines.CodeBuildStep('BetaFunctionalTests', {
                input: source,
                commands: ['npm ci', 'npm run test:functional'],
                partialBuildSpec: NODE_20_BUILD_SPEC,
            })],
        });

        // Gamma: end-to-end tests against the prod-like Gamma environment, then
        // a bake time — the last checks before production.
        const gammaE2ETests = new pipelines.CodeBuildStep('GammaE2ETests', {
            input: source,
            commands: ['npm ci', 'npm run test:e2e'],
            partialBuildSpec: NODE_20_BUILD_SPEC,
        });

        // Bake time: no tests, no load generation, no checks of its own — just
        // a timed hold after the Gamma deploy so the stack's CloudWatch alarms
        // have a window to fire on a bad build before the prod gate. See
        // scripts/bake-time.ts for the checks planned as future work (Lambda
        // memory usage, system-health alarm, error-log count).
        const gammaBakeTime = new pipelines.CodeBuildStep('GammaBakeTime', {
            input: source,
            commands: ['npm ci', 'npx tsx scripts/bake-time.ts'],
            partialBuildSpec: BAKE_BUILD_SPEC,
        });
        // Bake only starts once E2E has passed, cheap gate first.
        gammaBakeTime.addStepDependency(gammaE2ETests);

        pipeline.addStage(new AppStage(this, 'Gamma', { stageLabel: 'Gamma' }), {
            post: [gammaE2ETests, gammaBakeTime],
        });


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
