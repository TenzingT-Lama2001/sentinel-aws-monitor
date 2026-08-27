import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { SNSEvent, SNSHandler } from 'aws-lambda'

const dbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE_NAME = process.env.INCIDENT_TABLE_NAME;

// The dimension the crawler tags every metric with, and therefore the one
// the alarm carries into its notification. Must match `dimensionsMap` in
// the stack (`{ SiteId: site.siteId }`).
const SITE_DIMENSION = 'SiteId';

/**
 * The JSON string inside an SNS record's `Message` for a CloudWatch alarm
 * action. Top-level keys and `Trigger.*` are PascalCase; the objects *inside*
 * `Trigger.Dimensions` use lowercase `name` / `value` — that inconsistency
 * is AWS's, not a typo.
 */
interface CloudWatchAlarmMessage {
    AlarmName: string;
    NewStateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
    NewStateReason: string;
    StateChangeTime: string;
    Trigger: {
        MetricName: string;
        Dimensions: Array<{ name: string; value: string }>;
    }
}

export interface IncidentRecord {
    siteId: string;
    incidentId: string;
    timestamp: string;
    alarmName: string;
    metricName: string;
    state: CloudWatchAlarmMessage['NewStateValue'];
    reason: string;
}

export function parseIncident(rawMessage: string): IncidentRecord {
    const message = JSON.parse(rawMessage) as CloudWatchAlarmMessage;

    const siteId = message.Trigger.Dimensions.find((d) => d.name === SITE_DIMENSION)?.value;

    if (!siteId) {
        throw new Error(`Alarm message for "${message.AlarmName}" has no ${SITE_DIMENSION} dimension`);
    }

    return {
        siteId,
        incidentId: `${message.StateChangeTime}#${message.AlarmName}`,
        timestamp: message.StateChangeTime,
        alarmName: message.AlarmName,
        metricName: message.Trigger.MetricName,
        state: message.NewStateValue,
        reason: message.NewStateReason
    }
}

async function writeIncident(record: IncidentRecord): Promise<void> {
    if (!TABLE_NAME) {
        throw new Error('INCIDENT_TABLE_NAME environment variable is not set');
    }
    await dbClient.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: record
        })
    )
}

/**
 * SNS invokes this once per alarm notification, and an SNS event always
 * carries exactly one record — so there is no partial-batch bookkeeping to
 * do. If parsing or the write throws, the whole invocation fails and Lambda
 * retries it (twice more, by default). The Put is keyed entirely from the
 * message (`siteId` + `<stateChangeTime>#<alarmName>`), so a retry just
 * rewrites the same row — repeating it is harmless.
 */
export const handler: SNSHandler = async (event: SNSEvent) => {
    for (const record of event.Records) {
        const incident = parseIncident(record.Sns.Message);
        await writeIncident(incident);
        console.log('Logged incident', JSON.stringify(incident));
    }
}
