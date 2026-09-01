/**
 * Shared parser for the CloudWatch-alarm SNS payload.
 *
 * Both `incident-logger.ts` (writes each state change to DynamoDB) and
 * `slack-notifier.ts` (posts each state change to Slack) subscribe to the
 * same `alertTopic` and receive the exact same message. Parsing it in one
 * place means the two consumers can't drift apart on what a field means.
 */

// The dimension the crawler tags every metric with, and therefore the one
// the alarm carries into its notification. Must match `dimensionsMap` in
// the stack (`{ SiteId: site.siteId }`).
export const SITE_DIMENSION = 'SiteId';

export type AlarmState = 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';

/**
 * The JSON string inside an SNS record's `Message` for a CloudWatch alarm
 * action. Top-level keys and `Trigger.*` are PascalCase; the objects *inside*
 * `Trigger.Dimensions` use lowercase `name` / `value` — that inconsistency
 * is AWS's, not a typo.
 */
interface CloudWatchAlarmMessage {
    AlarmName: string;
    // Human-readable text set per-alarm in the stack (`alarmDescription:`),
    // e.g. "Example Site has been down for 2 consecutive checks (10 min)".
    // Always present in a CloudWatch alarm notification.
    AlarmDescription: string;
    NewStateValue: AlarmState;
    OldStateValue: AlarmState;
    NewStateReason: string;
    StateChangeTime: string;
    // Human region name, e.g. "Asia Pacific (Sydney)". Present on every
    // CloudWatch alarm notification — the stack runs one copy per region.
    Region: string;
    // e.g. "arn:aws:cloudwatch:ap-southeast-2:123456789012:alarm:MyAlarm" —
    // the only place the region *code* appears (needed to build console URLs).
    AlarmArn: string;
    Trigger: {
        MetricName: string;
        Dimensions: Array<{ name: string; value: string }>;
    };
}

/** The fields we lift straight off one alarm SNS message. */
export interface ParsedAlarm {
    siteId: string;
    timestamp: string;
    alarmName: string;
    description: string;
    metricName: string;
    state: AlarmState;
    previousState: AlarmState;
    reason: string;
    region: string;      // display name, e.g. "Asia Pacific (Sydney)"
    regionCode: string;  // e.g. "ap-southeast-2", for console URLs
}

export function parseAlarmMessage(rawMessage: string): ParsedAlarm {
    const message = JSON.parse(rawMessage) as CloudWatchAlarmMessage;

    const siteId = message.Trigger.Dimensions.find((d) => d.name === SITE_DIMENSION)?.value;

    if (!siteId) {
        throw new Error(`Alarm message for "${message.AlarmName}" has no ${SITE_DIMENSION} dimension`);
    }

    // arn:aws:cloudwatch:<region>:<account>:alarm:<name>
    const regionCode = message.AlarmArn.split(':')[3] ?? '';

    return {
        siteId,
        timestamp: message.StateChangeTime,
        alarmName: message.AlarmName,
        description: message.AlarmDescription,
        metricName: message.Trigger.MetricName,
        state: message.NewStateValue,
        previousState: message.OldStateValue,
        reason: message.NewStateReason,
        region: message.Region,
        regionCode,
    };
}
