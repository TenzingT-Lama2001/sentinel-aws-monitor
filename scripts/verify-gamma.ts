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

const STACK_NAME = "SentinelAwsMonitorStack-Sydney-Gamma";

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
      `Could not find ${logicalId} in ${STACK_NAME}`,
    );
  }

  return resource.PhysicalResourceId;
}

async function invokeLambda(
  functionName: string,
): Promise<unknown> {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from("{}"),
    }),
  );

  if (response.FunctionError) {
    throw new Error(
      `Lambda returned an error: ${response.FunctionError}`,
    );
  }

  const payload = response.Payload
    ? Buffer.from(response.Payload).toString("utf-8")
    : "";

  return payload ? JSON.parse(payload) : undefined;
}

async function main(): Promise<void> {
  console.log("======================================");
  console.log("Gamma Verification Test");
  console.log("======================================");
  console.log(`Region: ${region}`);
  console.log(`Stack: ${STACK_NAME}`);

  const crawlerFunction = await findLambdaFunction(
    "CrawlerFunction",
  );

  console.log(`Crawler Lambda: ${crawlerFunction}`);

  const result = await invokeLambda(crawlerFunction);

  if (!Array.isArray(result)) {
    throw new Error(
      "Gamma verification failed: crawler did not return an array.",
    );
  }

  if (result.length === 0) {
    throw new Error(
      "Gamma verification failed: no monitored sites were returned.",
    );
  }

  console.log(
    `Gamma crawler returned ${result.length} site result(s).`,
  );

  const availabilityResults = result.filter(
    (item: any) => typeof item.up === "boolean",
  );

  if (availabilityResults.length !== result.length) {
    throw new Error(
      "Gamma verification failed: one or more results do not contain a valid availability value.",
    );
  }

  const certificateResults = result.filter(
    (item: any) =>
      item.certificateDaysRemaining !== undefined ||
      item.certificateError !== undefined,
  );

  console.log(
    `Availability results validated: ${availabilityResults.length}`,
  );

  console.log(
    `Certificate results observed: ${certificateResults.length}`,
  );

  console.log("Crawler integration test passed.");
  console.log("Gamma verification PASSED.");
}

main().catch((error) => {
  console.error("======================================");
  console.error("Gamma verification FAILED");
  console.error("======================================");
  console.error(error);
  process.exit(1);
});
