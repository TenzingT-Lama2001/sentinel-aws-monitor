import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";

import {
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";

const region = process.env.AWS_REGION ?? "ap-southeast-2";

const cloudFormation = new CloudFormationClient({
  region,
});

const lambda = new LambdaClient({
  region,
});

const STACK_NAME = "SentinelAwsMonitorStack-Sydney-Beta";

async function findLambdaFunction(
  logicalId: string,
): Promise<string> {
  const response = await cloudFormation.send(
    new DescribeStackResourcesCommand({
      StackName: STACK_NAME,
    }),
  );

  const resource = response.StackResources?.find(
    (item) => item.LogicalResourceId === logicalId,
  );

  if (!resource?.PhysicalResourceId) {
    throw new Error(
      `Could not find Lambda ${logicalId} in ${STACK_NAME}`,
    );
  }

  return resource.PhysicalResourceId;
}

async function invokeLambda(functionName: string): Promise<unknown> {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from("{}"),
    }),
  );

  if (response.FunctionError) {
    throw new Error(
      `Lambda ${functionName} returned an error: ${response.FunctionError}`,
    );
  }

  const payload = response.Payload
    ? Buffer.from(response.Payload).toString("utf-8")
    : "";

  return payload ? JSON.parse(payload) : undefined;
}

async function main(): Promise<void> {
  console.log("======================================");
  console.log("Beta Smoke Test");
  console.log("======================================");
  console.log(`Region: ${region}`);
  console.log(`Stack: ${STACK_NAME}`);

  const crawlerFunction = await findLambdaFunction(
    "CrawlerFunction",
  );

  console.log(`Crawler Lambda: ${crawlerFunction}`);

  const result = await invokeLambda(crawlerFunction);

  console.log("Crawler invocation succeeded.");

  if (!Array.isArray(result)) {
    throw new Error(
      "Beta smoke test failed: crawler did not return an array of site results.",
    );
  }

  if (result.length === 0) {
    throw new Error(
      "Beta smoke test failed: crawler returned zero site results.",
    );
  }

  console.log(
    `Crawler returned ${result.length} site result(s).`,
  );

  const invalidResults = result.filter(
    (item: any) =>
      typeof item.siteId !== "string" ||
      typeof item.name !== "string" ||
      typeof item.url !== "string" ||
      typeof item.up !== "boolean",
  );

  if (invalidResults.length > 0) {
    throw new Error(
      `Beta smoke test failed: ${invalidResults.length} invalid site result(s) returned.`,
    );
  }

  console.log("All crawler results have the expected structure.");
  console.log("Beta smoke test PASSED.");
}

main().catch((error) => {
  console.error("======================================");
  console.error("Beta smoke test FAILED");
  console.error("======================================");
  console.error(error);
  process.exit(1);
});
