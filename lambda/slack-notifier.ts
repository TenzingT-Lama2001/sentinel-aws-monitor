/**
 * Slack notifier Lambda — real-time alarm/OK notifications.
 *
 * A second subscriber on the same `alertTopic` the incident logger listens
 * to: every alarm state change already emails the on-call address and writes
 * a row to the incident table; this adds a third, independent destination —
 * a short human-readable line in a Slack channel.
 *
 * The webhook URL is a bearer secret (anyone holding it can post to the
 * channel), so it lives in SSM Parameter Store as a SecureString created by
 * hand — CDK only references it. We fetch it once per cold start and cache
 * it for the life of the execution environment.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import type { SNSEvent, SNSHandler } from 'aws-lambda'
import { parseAlarmMessage, type AlarmState, type ParsedAlarm } from './alarm-message'

const ssm = new SSMClient({}) // created once, reused across invocations

// Set by CDK to the SecureString parameter name, e.g.
// "/sentinel/slack/alerts-webhook-url". No fallback — a missing name is fatal.
const WEBHOOK_PARAM_NAME = process.env.SLACK_WEBHOOK_PARAM_NAME

// Set by CDK to the CloudWatch dashboard URL. Optional — if unset, the
// message just omits the "Dashboard" link.
const DASHBOARD_URL = process.env.DASHBOARD_URL

// Cached across warm invocations so we hit SSM once per cold start, not once
// per notification.
let cachedWebhookUrl: string | undefined

async function getWebhookUrl(): Promise<string> {
    if (cachedWebhookUrl) {
        return cachedWebhookUrl
    }
    if (!WEBHOOK_PARAM_NAME) {
        throw new Error('SLACK_WEBHOOK_PARAM_NAME environment variable is not set')
    }

    const response = await ssm.send(
        new GetParameterCommand({ Name: WEBHOOK_PARAM_NAME, WithDecryption: true }),
    )

    const url = response.Parameter?.Value
    if (!url) {
        throw new Error(`SSM parameter "${WEBHOOK_PARAM_NAME}" has no value`)
    }

    cachedWebhookUrl = url
    return url
}

const STATE_EMOJI: Record<AlarmState, string> = {
    ALARM: '🔴',
    OK: '✅',
    INSUFFICIENT_DATA: '⚠️',
}

// What to call each state in the message. INSUFFICIENT_DATA is CloudWatch's
// term; "NO DATA" is what it actually means to a reader.
const STATE_LABEL: Record<AlarmState, string> = {
    ALARM: 'ALARM',
    OK: 'OK',
    INSUFFICIENT_DATA: 'NO DATA',
}

/** Deep link to this alarm in the CloudWatch console (same target the CloudWatch email uses). */
function alarmConsoleUrl(regionCode: string, alarmName: string): string {
    return `https://${regionCode}.console.aws.amazon.com/cloudwatch/deeplink.js` +
        `?region=${regionCode}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`
}

/**
 * Slack renders `<!date^unix^format|fallback>` in each viewer's own timezone.
 * The fallback (plain UTC) shows if the timestamp can't be parsed or in
 * contexts where Slack doesn't localise (e.g. push notifications).
 */
function formatTimestamp(iso: string): string {
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) return iso
    const unix = Math.floor(ms / 1000)
    const fallback = `${iso.slice(0, 16).replace('T', ' ')} UTC`
    return `<!date^${unix}^{date_short_pretty} {time}|${fallback}>`
}

/** Drop CloudWatch's "Threshold Crossed:" boilerplate; keep the substance. */
function tidyReason(reason: string): string {
    return reason.replace(/^Threshold Crossed:\s*/, '')
}

/**
 * Title line + labelled detail block + links, e.g.:
 *
 *   🔴 *ALARM:*  Availability · site-04  ·  Asia Pacific (Sydney)
 *
 *   *Description:*  Example Org has been down for 2 consecutive checks (10 min)
 *   *Reason:*  no datapoints were received for 3 periods ...
 *   *Change:*  INSUFFICIENT_DATA → ALARM
 *   *Time:*  Sep 1, 2026 4:58 AM
 *   *Alarm:*  `SentinelAwsMonitorStack-Sydney-Availability-site-04`
 *
 *   <…|View alarm>  ·  <…|Dashboard>
 *
 * For ALARM/OK the per-alarm `description` is a ready-made sentence. For
 * INSUFFICIENT_DATA that sentence describes a threshold breach that didn't
 * happen, so we state what actually did: the metric stopped reporting.
 */
export function formatMessage(alarm: ParsedAlarm, dashboardUrl?: string): string {
    const emoji = STATE_EMOJI[alarm.state] ?? '❓'
    const label = STATE_LABEL[alarm.state] ?? alarm.state

    const description =
        alarm.state === 'INSUFFICIENT_DATA'
            ? `${alarm.metricName} stopped reporting for ${alarm.siteId}`
            : alarm.description || alarm.alarmName

    const links = [`<${alarmConsoleUrl(alarm.regionCode, alarm.alarmName)}|View alarm>`]
    if (dashboardUrl) {
        links.push(`<${dashboardUrl}|Dashboard>`)
    }

    return [
        `${emoji} *${label}:*  ${alarm.metricName} · ${alarm.siteId}  ·  ${alarm.region}`,
        '',
        `*Description:*  ${description}`,
        `*Reason:*  ${tidyReason(alarm.reason)}`,
        `*Change:*  ${alarm.previousState} → ${alarm.state}`,
        `*Time:*  ${formatTimestamp(alarm.timestamp)}`,
        `*Alarm:*  \`${alarm.alarmName}\``,
        '',
        links.join('  ·  '),
    ].join('\n')
}

async function postToSlack(text: string): Promise<void> {
    const url = await getWebhookUrl()

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    })

    if (!response.ok) {
        // Throw so Lambda retries. Slack returns the reason as plain text.
        const body = await response.text().catch(() => '')
        throw new Error(`Slack webhook returned ${response.status}: ${body}`)
    }
}

/**
 * SNS delivers exactly one record per invocation. If parsing or the POST
 * throws, the whole invocation fails and Lambda retries it (twice more, by
 * default) — a duplicate Slack post on retry is preferable to a missed alert.
 */
export const handler: SNSHandler = async (event: SNSEvent) => {
    for (const record of event.Records) {
        const alarm = parseAlarmMessage(record.Sns.Message)

        await postToSlack(formatMessage(alarm, DASHBOARD_URL))
        console.log('Posted to Slack', JSON.stringify({ siteId: alarm.siteId, state: alarm.state, alarmName: alarm.alarmName }))
    }
}
