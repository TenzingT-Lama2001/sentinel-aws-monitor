import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";

import {
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";

jest.setTimeout(120000);

const regions = [
  {
    name: "Singapore",
    region: "ap-southeast-1",
    stackName: "SentinelAwsMonitorStack-Singapore-Beta",
  },
  {
    name: "Sydney",
    region: "ap-southeast-2",
    stackName: "SentinelAwsMonitorStack-Sydney-Beta",
  },
];

async function getCrawlerFunctionName(
  region: string,
  stackName: string,
): Promise<string> {
  const cloudFormation = new CloudFormationClient({
    region,
  });

  const response = await cloudFormation.send(
    new DescribeStackResourcesCommand({
      StackName: stackName,
    }),
  );

  const crawler = response.StackResources?.find(
    (resource) => resource.LogicalResourceId === "CrawlerFunction",
  );

  if (!crawler?.PhysicalResourceId) {
    throw new Error(
      `CrawlerFunction was not found in ${stackName} (${region})`,
    );
  }

  return crawler.PhysicalResourceId;
}

async function runCrawler(
  region: string,
  functionName: string,
): Promise<unknown[]> {
  const lambda = new LambdaClient({
    region,
  });

  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from("{}"),
    }),
  );

  if (response.FunctionError) {
    throw new Error(
      `Crawler Lambda failed in ${region}: ${response.FunctionError}`,
    );
  }

  if (!response.Payload) {
    throw new Error(`Crawler returned no payload in ${region}`);
  }

  const payloadText = Buffer.from(response.Payload).toString("utf-8");

  let results: unknown;

  try {
    results = JSON.parse(payloadText);
  } catch {
    throw new Error(
      `Crawler returned invalid JSON in ${region}: ${payloadText}`,
    );
  }

  if (!Array.isArray(results)) {
    throw new Error(
      `Crawler result is not an array in ${region}`,
    );
  }

  return results;
}

describe("Beta Functional Tests", () => {
  test.each(regions)(
    "$name Beta environment - deployed crawler works",
    async ({ name, region, stackName }) => {
      console.log("");
      console.log("========================================");
      console.log(`Beta Functional Test - ${name}`);
      console.log("========================================");
      console.log(`Region: ${region}`);
      console.log(`Stack: ${stackName}`);

      const functionName = await getCrawlerFunctionName(
        region,
        stackName,
      );

      console.log(`Crawler Lambda: ${functionName}`);

      const results = await runCrawler(
        region,
        functionName,
      );

      console.log(`Crawler returned ${results.length} result(s).`);

      expect(results.length).toBeGreaterThan(0);

      for (const result of results) {
        expect(result).toBeDefined();
        expect(typeof result).toBe("object");
      }

      console.log(`Beta ${name} functional test PASSED.`);
    },
  );
});
