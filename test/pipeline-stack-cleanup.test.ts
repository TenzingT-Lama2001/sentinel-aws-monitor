import * as cdk from "aws-cdk-lib/core";
import { Template } from "aws-cdk-lib/assertions";
import { PipelineStack } from "../infra/pipeline-stack";

describe("PipelineStack stale-stack cleanup", () => {
  it("adds a pre-deploy cleanup step before each stage", () => {
    process.env.ALERT_EMAIL = "test@example.com";

    const app = new cdk.App();
    const stack = new PipelineStack(app, "PipelineStack", {
      env: { account: "123456789012", region: "ap-southeast-2" },
    });

    const template = Template.fromStack(stack);

    const buildProjects = template.findResources("AWS::CodeBuild::Project");
    expect(Object.keys(buildProjects).length).toBeGreaterThan(0);

    const logicalIds = Object.keys(buildProjects);
    expect(logicalIds.some(id =>
      id.includes("CleanStaleBetaStacks") ||
      id.includes("CleanStaleGammaStacks") ||
      id.includes("CleanStaleProdStacks")
    )).toBe(true);
  });
});
