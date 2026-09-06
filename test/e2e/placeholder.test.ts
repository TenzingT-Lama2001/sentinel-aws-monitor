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
    stackName: "SentinelAwsMonitorStack-Singapore-Gamma",
  },
  {
    name: "Sydney",
    region: "ap-southeast-2",
    stackName: "SentinelAwsMonitorStack-Sydney-Gamma",
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

async function invokeCrawler(
  region: string,
  functionName: string,
): Promise<unknown> {
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

  try {
    return JSON.parse(payloadText);
  } catch {
    throw new Error(
      `Crawler returned invalid JSON in ${region}: ${payloadText}`,
    );
  }
}

describe("Gamma End-to-End Tests", () => {
  test.each(regions)(
    "$name Gamma environment - crawler end-to-end check",
    async ({ name, region, stackName }) => {
      console.log("");
      console.log("========================================");
      console.log(`Gamma E2E Test - ${name}`);
      console.log("========================================");
      console.log(`Region: ${region}`);
      console.log(`Stack: ${stackName}`);

      const functionName = await getCrawlerFunctionName(
        region,
        stackName,
      );

      console.log(`Crawler Lambda: ${functionName}`);

      const results = await invokeCrawler(
        region,
        functionName,
      );

      expect(Array.isArray(results)).toBe(true);

      const crawlerResults = results as Array<{
        url?: unknown;
        up?: unknown;
        statusCode?: unknown;
        latencyMs?: unknown;
      }>;

      expect(crawlerResults.length).toBeGreaterThan(0);

      for (const result of crawlerResults) {
        expect(typeof result.up).toBe("boolean");

        if (result.url !== undefined) {
          expect(typeof result.url).toBe("string");
        }

        if (result.statusCode !== undefined) {
          expect(typeof result.statusCode).toBe("number");
        }

        if (result.latencyMs !== undefined) {
          expect(typeof result.latencyMs).toBe("number");
        }
      }

      console.log(
        `Gamma ${name} E2E test PASSED.`,
      );
    },
  );
});
