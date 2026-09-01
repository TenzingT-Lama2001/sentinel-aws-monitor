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
    NewStateReason: string;
    StateChangeTime: string;
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
    reason: string;
}

export function parseAlarmMessage(rawMessage: string): ParsedAlarm {
    const message = JSON.parse(rawMessage) as CloudWatchAlarmMessage;

    const siteId = message.Trigger.Dimensions.find((d) => d.name === SITE_DIMENSION)?.value;

    if (!siteId) {
        throw new Error(`Alarm message for "${message.AlarmName}" has no ${SITE_DIMENSION} dimension`);
    }

    return {
        siteId,
        timestamp: message.StateChangeTime,
        alarmName: message.AlarmName,
        description: message.AlarmDescription,
        metricName: message.Trigger.MetricName,
        state: message.NewStateValue,
        reason: message.NewStateReason,
    };
}
