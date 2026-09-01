import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { SNSEvent, SNSHandler } from 'aws-lambda'
import { parseAlarmMessage, type AlarmState } from './alarm-message'

const dbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const TABLE_NAME = process.env.INCIDENT_TABLE_NAME;

export interface IncidentRecord {
    siteId: string;
    incidentId: string;
    timestamp: string;
    alarmName: string;
    metricName: string;
    state: AlarmState;
    reason: string;
}

/**
 * Maps one parsed alarm message to the incident-table row shape.
 *
 * The `incidentId` sort key is `"<stateChangeTime>#<alarmName>"` — the
 * timestamp leads so rows sort chronologically, and the `#<alarmName>`
 * suffix keeps two alarms that flip in the same instant from sharing a key.
 */
export function toIncidentRecord(rawMessage: string): IncidentRecord {
    const alarm = parseAlarmMessage(rawMessage);

    return {
        siteId: alarm.siteId,
        incidentId: `${alarm.timestamp}#${alarm.alarmName}`,
        timestamp: alarm.timestamp,
        alarmName: alarm.alarmName,
        metricName: alarm.metricName,
        state: alarm.state,
        reason: alarm.reason,
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
        const incident = toIncidentRecord(record.Sns.Message);

        // The table records outages and recoveries. The latency/cert alarms
        // also publish INSUFFICIENT_DATA to this topic now (for the Slack
        // "no data" notification) — that's an operational signal, not an
        // incident, so it doesn't belong in the table.
        if (incident.state !== 'ALARM' && incident.state !== 'OK') {
            console.log('Skipped non-incident state', JSON.stringify(incident));
            continue;
        }

        await writeIncident(incident);
        console.log('Logged incident', JSON.stringify(incident));
    }
}
