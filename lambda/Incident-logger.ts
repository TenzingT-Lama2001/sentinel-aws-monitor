import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({});

const TABLE_NAME = process.env.INCIDENT_TABLE_NAME;

export const handler = async (event: any) => {
  console.log("SNS event received:", JSON.stringify(event));

  if (!TABLE_NAME) {
    throw new Error("INCIDENT_TABLE_NAME is not configured");
  }

  for (const record of event.Records ?? []) {
    const alarm = JSON.parse(record.Sns.Message);

    const siteId =
      alarm.Trigger?.Dimensions?.find(
        (d: any) => d.name === "SiteId"
      )?.value ?? "unknown";

    const metricType =
      alarm.Trigger?.MetricName ?? "Unknown";

    const timestamp =
      alarm.StateChangeTime ?? new Date().toISOString();

    const incidentId = `${siteId}-${metricType}-${timestamp}`;

    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,

        Item: {
          siteId: {
            S: siteId,
          },

          timestamp: {
            S: timestamp,
          },

          incidentId: {
            S: incidentId,
          },

          metricType: {
            S: metricType,
          },

          alarmState: {
            S: alarm.NewStateValue ?? "UNKNOWN",
          },

          alarmName: {
            S: alarm.AlarmName ?? "Unknown",
          },

          stateReason: {
            S: alarm.NewStateReason ?? "",
          },

          region: {
            S:
              alarm.Region ??
              process.env.AWS_REGION ??
              "unknown",
          },

          threshold: {
            N: String(
              alarm.Trigger?.Threshold ?? 0
            ),
          },
        },
      })
    );

    console.log(
      `Incident stored in DynamoDB: ${incidentId}`
    );
  }
};
